"""
Turns raw detection evidence into human-readable explanation sentences.

Two layers:
  1. Rule-based (always runs, zero dependencies) — deterministic templates
     fed by the exact evidence the detector found. This is what ships in
     every alert by default and what the app falls back to if Gemini is
     unavailable for any reason.
  2. Gemini polish (optional) — if GEMINI_API_KEY is set in .env, FraudGraph
     sends the rule-based facts to Gemini and asks it to rewrite them as
     tighter investigator-facing prose. The underlying facts never change;
     Gemini only touches wording. If the call fails (no key, bad key, no
     internet, timeout, bad response) we silently keep the rule-based
     version — the API layer never surfaces a Gemini failure to the user
     as an error.

Data privacy: account and device identifiers are replaced with neutral
placeholders (ACCOUNT_A, DEVICE_A, ...) BEFORE anything is sent to Gemini and
restored afterwards, so Google never sees real identifiers. Transaction amounts
and counts are still sent (they are the substance of the explanation). Leave
GEMINI_API_KEY blank to send nothing at all.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Dict, List, Optional, Tuple

import requests

from app.config import settings
from app.detection import PatternFlag

logger = logging.getLogger("fraudgraph.explain")


# ---------------------------------------------------------------------------
# 1. Rule-based explanation (the backbone — always available)
# ---------------------------------------------------------------------------

# The large-amount signal is a minor score bonus, not an alert of its own, so the account
# detail endpoint appends this sentence itself when the pattern is present.
LARGE_AMOUNT_SENTENCE = "Sent at least one transfer in the top 1% of all transaction amounts observed"


def _sentence_for_flag(flag: PatternFlag) -> str:
    e = flag.evidence
    p = flag.pattern

    if p == "fan_in_collector":
        return (
            f"Received funds from {e['sender_count']} distinct accounts "
            f"within a {e['window_hours']}-hour window, totalling "
            f"₦{e['total_amount']:,.2f}"
        )
    if p == "fan_in_feeder":
        return f"Sent funds into {e['collector']}, part of a wider fan-in pattern"
    if p == "cycle_member":
        return (
            f"Part of a {e['ring_size']}-account circular transfer chain — "
            f"funds moved through the ring and returned to a prior member"
        )
    if p == "shared_device_member":
        return (
            f"Transacted from a device shared with {e['co_account_count']} "
            f"other distinct account(s)"
        )
    if p == "rapid_passthrough":
        ratio = e["out_amount"] / e["in_amount"] if e["in_amount"] else 0
        if ratio <= 1.5:
            return (
                f"Received ₦{e['in_amount']:,.2f} and sent out ₦{e['out_amount']:,.2f} "
                f"({ratio:.0%} of it) just {e['minutes']} minutes later"
            )
        # outbound far exceeds this one inbound — reads as a pooled cash-out of
        # several smaller inflows, not a 1:1 pass-through, so phrase it as such
        return (
            f"Received ₦{e['in_amount']:,.2f}, then sent out a much larger "
            f"₦{e['out_amount']:,.2f} just {e['minutes']} minutes later — consistent "
            f"with cashing out several pooled inbound transfers at once"
        )
    if p == "large_amount_anomaly":
        return LARGE_AMOUNT_SENTENCE
    if p == "statistical_anomaly":
        reasons = e.get("reasons", [])
        if reasons:
            joined = "; ".join(reasons[:2])
            return f"Flagged by unsupervised anomaly detection: {joined}"
        anom_score = e.get("anomaly_score", 0.0)
        return f"Flagged by unsupervised anomaly detection: behavioral profile deviates significantly from baseline (score: {anom_score:.1%})"
    return f"Flagged for pattern: {p}"


def rule_based_explanation(flags: List[PatternFlag]) -> List[str]:
    seen = set()
    sentences = []
    for f in flags:
        s = _sentence_for_flag(f)
        if s not in seen:
            sentences.append(s)
            seen.add(s)
    return sentences


# ---------------------------------------------------------------------------
# 2. Optional Gemini polish
# ---------------------------------------------------------------------------

GEMINI_URL_TEMPLATE = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

_GEMINI_PROMPT = """You are writing a short explanation for a bank fraud investigator \
reviewing an automated alert. You are given a list of FACTS a rule-based fraud \
detection system found about one account. Rewrite them as 2-4 short, clear bullet \
sentences an investigator can scan quickly. Do not invent any fact that isn't in \
the list. Do not soften or hedge the facts. Keep numbers exactly as given. Keep \
placeholders such as ACCOUNT_A or DEVICE_A exactly as written. Return \
ONLY a JSON array of strings, nothing else - no markdown, no preamble.

FACTS:
{facts}
"""

# After this many consecutive failures Gemini is switched off for the rest of the
# process, so a bad key or no internet cannot slow seeding down (one 8s timeout per alert).
_MAX_CONSECUTIVE_FAILURES = 3
_consecutive_failures = 0
_gemini_disabled = False

_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
_PLACEHOLDER_RE = re.compile(r"\b(?:ACCOUNT|DEVICE)_[A-Z]+\b")


def reset_gemini_state() -> None:
    global _consecutive_failures, _gemini_disabled
    _consecutive_failures = 0
    _gemini_disabled = False


def gemini_is_active() -> bool:
    return bool(settings.gemini_api_key) and not _gemini_disabled


def _record_failure(reason: object) -> None:
    global _consecutive_failures, _gemini_disabled
    _consecutive_failures += 1
    logger.warning("Gemini explanation call failed, falling back to rule-based: %s", reason)
    if _consecutive_failures >= _MAX_CONSECUTIVE_FAILURES and not _gemini_disabled:
        _gemini_disabled = True
        logger.warning("Gemini failed %d times in a row - disabled for the rest of this run.",
                       _consecutive_failures)


def _placeholder(prefix: str, index: int) -> str:
    letters = ""
    n = index
    while True:
        letters = chr(ord("A") + n % 26) + letters
        n = n // 26 - 1
        if n < 0:
            return f"{prefix}_{letters}"


def _collect_identifiers(flags: List[PatternFlag]) -> Tuple[List[str], List[str]]:
    """Account and device identifiers mentioned in the evidence of these flags."""
    accounts: List[str] = []
    devices: List[str] = []

    def add(bucket: List[str], value: object) -> None:
        if isinstance(value, str) and value and value not in bucket:
            bucket.append(value)

    for f in flags:
        e = f.evidence
        add(accounts, e.get("collector"))
        add(devices, e.get("device_id"))
        for key in ("senders", "accounts", "ring_members"):
            for v in e.get(key, []) or []:
                add(accounts, v)
    return accounts, devices


def _mask(text: str, mapping: Dict[str, str]) -> str:
    for real in sorted(mapping, key=len, reverse=True):  # longest first avoids partial overlaps
        text = text.replace(real, mapping[real])
    return text


def _numbers(text: str) -> set:
    """Numeric values in the text (compared by value, so '5.0' and '5' are the same number)."""
    return {float(m.replace(",", "")) for m in _NUMBER_RE.findall(text)}


def _call_gemini(prompt: str) -> Optional[str]:
    """POST to Gemini; tries the fallback model if the primary has been retired (404)."""
    models = [settings.gemini_model]
    if settings.gemini_fallback_model and settings.gemini_fallback_model != settings.gemini_model:
        models.append(settings.gemini_fallback_model)

    last_error: object = "no model attempted"
    for model in models:
        try:
            resp = requests.post(
                GEMINI_URL_TEMPLATE.format(model=model),
                headers={"x-goog-api-key": settings.gemini_api_key, "Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
                },
                timeout=settings.gemini_timeout_seconds,
            )
            if resp.status_code == 404:
                last_error = f"model '{model}' not found (retired?)"
                continue
            resp.raise_for_status()
            parts = resp.json()["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            if text:
                return text
            last_error = "empty response"
        except Exception as exc:  # noqa: BLE001 - any failure just means "fall back"
            _record_failure(exc)
            return None
    _record_failure(last_error)
    return None


def gemini_polish(facts: List[str], mapping: Optional[Dict[str, str]] = None) -> Optional[List[str]]:
    """Returns a polished list of sentences, or None if Gemini isn't configured,
    has been switched off, the call fails, or its answer fails validation.
    Callers must treat None as 'use rule_based_explanation instead'.

    `mapping` is {real_identifier: placeholder}; identifiers are masked before the
    request and restored in the reply."""
    global _consecutive_failures
    if not gemini_is_active() or not facts:
        return None

    mapping = mapping or {}
    masked_facts = [_mask(f, mapping) for f in facts]
    text = _call_gemini(_GEMINI_PROMPT.format(facts="\n".join(f"- {f}" for f in masked_facts)))
    if text is None:
        return None

    try:
        # Model sometimes wraps JSON in a markdown fence despite instructions - strip it.
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()

        parsed = json.loads(text)
        if not (isinstance(parsed, list) and parsed and all(isinstance(x, str) for x in parsed)):
            raise ValueError("response was not a non-empty JSON array of strings")

        joined = " ".join(parsed)
        # Guard rails: Gemini may only reword. Reject any number or placeholder that was not in the facts.
        extra_numbers = _numbers(joined) - _numbers(" ".join(masked_facts))
        if extra_numbers:
            raise ValueError(f"response introduced numbers not in the facts: {sorted(extra_numbers)[:3]}")
        unknown = set(_PLACEHOLDER_RE.findall(joined)) - set(mapping.values())
        if unknown:
            raise ValueError(f"response introduced unknown identifiers: {sorted(unknown)[:3]}")

        reverse = {v: k for k, v in mapping.items()}
        restored = [_mask(sentence, reverse) for sentence in parsed]
        _consecutive_failures = 0
        return restored
    except Exception as exc:  # noqa: BLE001
        _record_failure(exc)
        return None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build_explanation(flags: List[PatternFlag]) -> Tuple[List[str], str]:
    """Returns (sentences, source) where source is 'gemini' or 'rule_based'."""
    base = rule_based_explanation(flags)
    if not gemini_is_active():
        return base, "rule_based"

    accounts, devices = _collect_identifiers(flags)
    mapping = {a: _placeholder("ACCOUNT", i) for i, a in enumerate(accounts)}
    mapping.update({d: _placeholder("DEVICE", i) for i, d in enumerate(devices)})

    polished = gemini_polish(base, mapping)
    if polished:
        return polished, "gemini"
    return base, "rule_based"
