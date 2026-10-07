"""
FraudGraph detection engine.

Runs on data already in memory (a pandas DataFrame of transactions) and
produces, per account/device:
  - which fraud patterns it triggered, with the concrete evidence behind each
  - a combined risk score (0-100) and risk band
  - ready-to-store alert records

The four detectors are pure rule-based graph/temporal analysis with no network
or API dependency, so they always work with or without Gemini configured.
Gemini (see explain.py) only touches the *wording* of an explanation
afterwards, never the detection itself. The ML layer (ml.py) is a separate,
optional second opinion that is blended into the score in compute_account_scores.

Four detectors:
  1. Fan-in        - many distinct accounts funnelling money into one account
                     in a short window ("mule collector" pattern)
  2. Cycles        - money moves out through several accounts and loops back
                     to where it started, within a time window
  3. Shared device - many distinct accounts all transacting from one device
  4. Rapid pass-through - an account receives money and moves most of it
                     back out again within minutes

Every PatternFlag carries `detected_at`: the timestamp of the transaction that
completed the pattern, so alerts can be ordered by when the fraud happened
rather than by when the seed script ran.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx
import numpy as np
import pandas as pd

from app.config import settings

_EPOCH = pd.Timestamp("1970-01-01")


@dataclass
class PatternFlag:
    pattern: str
    evidence: dict  # structured facts used later to build the explanation sentence
    detected_at: Optional[pd.Timestamp] = None  # when the pattern was completed (txn time)


@dataclass
class DetectionResult:
    account_flags: Dict[str, List[PatternFlag]] = field(default_factory=lambda: defaultdict(list))
    device_flags: Dict[str, List[PatternFlag]] = field(default_factory=lambda: defaultdict(list))
    flagged_txn_ids: Dict[str, str] = field(default_factory=dict)  # txn_id -> reason string


def _to_seconds(ts: pd.Series) -> np.ndarray:
    """Datetime series -> float seconds since epoch (independent of pandas datetime unit)."""
    return (ts - _EPOCH).dt.total_seconds().to_numpy()


# ---------------------------------------------------------------------------
# Shared sliding-window helper (used by the fan-in detector AND the ML features)
# ---------------------------------------------------------------------------

def sliding_window_stats(
    ts_seconds: np.ndarray,
    senders: List[str],
    amounts: List[float],
    window_seconds: float,
) -> Tuple[int, int, int, float]:
    """
    One O(n) pass over time-sorted inbound transfers of a single receiver.

    Returns (best_distinct_senders, best_start, best_end, max_window_amount):
      - best_distinct_senders / best_start / best_end: the window (inclusive
        index range) containing the MOST distinct senders (first one on ties)
      - max_window_amount: the largest total inbound amount in any window
        (can come from a different window than the one above)
    """
    counts: Dict[str, int] = defaultdict(int)
    distinct = 0
    window_amount = 0.0
    best_cnt, best_start, best_end, best_amt = 0, 0, 0, 0.0
    start = 0
    for end in range(len(ts_seconds)):
        s = senders[end]
        if counts[s] == 0:
            distinct += 1
        counts[s] += 1
        window_amount += amounts[end]
        while ts_seconds[end] - ts_seconds[start] > window_seconds:
            old = senders[start]
            counts[old] -= 1
            if counts[old] == 0:
                distinct -= 1
            window_amount -= amounts[start]
            start += 1
        if distinct > best_cnt:
            best_cnt, best_start, best_end = distinct, start, end
        if window_amount > best_amt:
            best_amt = window_amount
    return best_cnt, best_start, best_end, best_amt


# ---------------------------------------------------------------------------
# 1. Fan-in detection
# ---------------------------------------------------------------------------

def detect_fan_in(df: pd.DataFrame, result: DetectionResult) -> None:
    window_s = timedelta(hours=settings.fanin_window_hours).total_seconds()

    for receiver, group in df.groupby("receiver_account", sort=False):
        if len(group) < settings.fanin_min_senders:
            continue  # cannot possibly have enough distinct senders

        g = group.sort_values("timestamp")
        ts_sec = _to_seconds(g["timestamp"])
        senders = g["sender_account"].tolist()
        txn_ids = g["txn_id"].tolist()
        amounts = g["amount"].tolist()

        # Use the window with the MOST distinct senders, not just the first one that
        # crosses the threshold - a burst of 15 feeders should flag all 15.
        best_cnt, b_start, b_end, _ = sliding_window_stats(ts_sec, senders, amounts, window_s)
        if best_cnt < settings.fanin_min_senders:
            continue

        window_senders = set(senders[b_start:b_end + 1])
        window_txn_ids = txn_ids[b_start:b_end + 1]
        total_amount = float(sum(amounts[b_start:b_end + 1]))
        completed_at = g["timestamp"].iloc[b_end]

        result.account_flags[receiver].append(PatternFlag(
            pattern="fan_in_collector",
            evidence={
                "sender_count": len(window_senders),
                "window_hours": settings.fanin_window_hours,
                "total_amount": total_amount,
                "txn_ids": window_txn_ids,
                "senders": sorted(window_senders),
            },
            detected_at=completed_at,
        ))
        for s, tid, ts in zip(senders[b_start:b_end + 1], window_txn_ids, g["timestamp"].iloc[b_start:b_end + 1]):
            result.account_flags[s].append(PatternFlag(
                pattern="fan_in_feeder",
                evidence={"collector": receiver, "txn_id": tid},
                detected_at=ts,
            ))
            result.flagged_txn_ids[tid] = f"Part of a fan-in pattern into {receiver}"


# ---------------------------------------------------------------------------
# 2. Cycle detection
# ---------------------------------------------------------------------------

def _best_time_ordered_walk(
    cycle: List[str],
    edges: Dict[Tuple[str, str], List[tuple]],
    window_s: float,
):
    """
    networkx returns each cycle starting at an ARBITRARY node, but a real money
    loop is time-ordered from wherever the money first moved. So try every
    rotation (and every candidate first transfer) and keep the walk where each
    hop happens at/after the previous one with the smallest overall span.

    edges[(u, v)] is a list of (ts_seconds, Timestamp, txn_id) sorted by time.
    Returns (span_seconds, ordered_members, txn_ids, last_timestamp) or None.
    """
    n = len(cycle)
    best = None
    for r in range(n):
        order = cycle[r:] + cycle[:r]
        hops = [(order[i], order[(i + 1) % n]) for i in range(n)]
        if any(h not in edges for h in hops):
            return None
        for first in edges[hops[0]]:
            t_prev = first[0]
            chosen = [first]
            ok = True
            for hop in hops[1:]:
                hop_edges = edges[hop]
                times = [e[0] for e in hop_edges]
                idx = bisect_left(times, t_prev)       # earliest transfer at/after the previous hop
                if idx >= len(hop_edges):
                    ok = False
                    break
                chosen.append(hop_edges[idx])
                t_prev = hop_edges[idx][0]
            if not ok:
                continue
            span = t_prev - first[0]
            if span <= window_s and (best is None or span < best[0]):
                best = (span, order, [c[2] for c in chosen], chosen[-1][1])
    return best


def detect_cycles(df: pd.DataFrame, result: DetectionResult) -> None:
    # Only meaningful-value transfers - layering cycles move real money, and this
    # keeps the search space small enough to run instantly.
    big = df[df["amount"] >= settings.cycle_min_amount]
    if big.empty:
        return

    edges: Dict[Tuple[str, str], List[tuple]] = defaultdict(list)
    ts_sec = _to_seconds(big["timestamp"])
    for sec, ts, tid, u, v in zip(ts_sec, big["timestamp"], big["txn_id"],
                                  big["sender_account"], big["receiver_account"]):
        if u != v:
            edges[(u, v)].append((float(sec), ts, tid))
    for lst in edges.values():
        lst.sort(key=lambda e: e[0])

    # Plain DiGraph for enumeration: parallel transfers are kept in `edges`.
    g = nx.DiGraph()
    g.add_edges_from(edges.keys())

    # length_bound needs networkx >= 3.1 (pinned in requirements.txt)
    cycles = nx.simple_cycles(g, length_bound=settings.cycle_max_length)

    window_s = timedelta(hours=settings.cycle_window_hours).total_seconds()
    seen_rings: Set[frozenset] = set()

    for cycle in cycles:
        if len(cycle) < 3:
            continue  # A<->B ping-pong is not a layering ring
        key = frozenset(cycle)
        if key in seen_rings:
            continue

        walk = _best_time_ordered_walk(list(cycle), edges, window_s)
        if walk is None:
            continue
        _, members, txn_ids, completed_at = walk

        seen_rings.add(key)
        for acc in members:
            result.account_flags[acc].append(PatternFlag(
                pattern="cycle_member",
                evidence={"ring_size": len(members), "ring_members": members, "txn_ids": txn_ids},
                detected_at=completed_at,
            ))
        for tid in txn_ids:
            result.flagged_txn_ids[tid] = f"Part of a {len(members)}-account circular transfer"


# ---------------------------------------------------------------------------
# 3. Shared-device detection
# ---------------------------------------------------------------------------

def detect_shared_devices(df: pd.DataFrame, result: DetectionResult) -> Dict[str, Set[str]]:
    with_dev = df[df["device_id"].notna()]
    if with_dev.empty:
        return {}

    # first time each account used each device
    first_use = (
        with_dev.groupby(["device_id", "sender_account"])["timestamp"].min().reset_index()
    )

    flagged_devices: Dict[str, Set[str]] = {}
    for device_id, grp in first_use.groupby("device_id", sort=False):
        if len(grp) < settings.shared_device_min_accounts:
            continue
        grp = grp.sort_values("timestamp")
        accts = set(grp["sender_account"])
        # the device became "shared enough" when the k-th distinct account first used it
        crossed_at = grp["timestamp"].iloc[settings.shared_device_min_accounts - 1]
        last_seen = grp["timestamp"].iloc[-1]

        flagged_devices[device_id] = accts
        result.device_flags[device_id].append(PatternFlag(
            pattern="shared_device",
            evidence={"account_count": len(accts), "accounts": sorted(accts)},
            detected_at=crossed_at,
        ))
        for acc in accts:
            result.account_flags[acc].append(PatternFlag(
                pattern="shared_device_member",
                evidence={"device_id": device_id, "co_account_count": len(accts) - 1},
                detected_at=last_seen,
            ))
    return flagged_devices


# ---------------------------------------------------------------------------
# 4. Rapid pass-through detection
# ---------------------------------------------------------------------------

def find_passthrough_events(
    df: pd.DataFrame,
    window_minutes: Optional[float] = None,
    min_ratio: Optional[float] = None,
    min_amount: Optional[float] = None,
) -> List[dict]:
    """
    For every inbound transfer of at least `min_amount`, find the first outbound
    transfer from the same account within the window that moves >= min_ratio of
    the inbound amount. Shared by the detector and the ML feature extractor so
    both always agree.

    The materiality floor matters: without it, an ordinary account that is paid
    a few thousand naira and sends a similar amount on within the hour is flagged.
    """
    window_s = (window_minutes if window_minutes is not None else settings.passthrough_window_minutes) * 60.0
    ratio = min_ratio if min_ratio is not None else settings.passthrough_min_ratio
    floor = min_amount if min_amount is not None else settings.passthrough_min_amount
    if df.empty:
        return []

    sec = _to_seconds(df["timestamp"])
    d = pd.DataFrame({
        "txn_id": df["txn_id"].to_numpy(),
        "sender": df["sender_account"].to_numpy(),
        "receiver": df["receiver_account"].to_numpy(),
        "amount": df["amount"].to_numpy(dtype=float),
        "sec": sec,
        "ts": df["timestamp"].to_numpy(),
    })

    # outbound transfers per account, sorted by time
    out_by_acc: Dict[str, tuple] = {}
    for acc, grp in d.sort_values("sec").groupby("sender", sort=False):
        out_by_acc[acc] = (grp["sec"].to_numpy(), grp["amount"].to_numpy(), grp["txn_id"].to_numpy(),
                           grp["ts"].to_numpy())

    events: List[dict] = []
    for in_id, acc, in_amt, in_sec in zip(d["txn_id"], d["receiver"], d["amount"], d["sec"]):
        if in_amt < floor:
            continue
        out = out_by_acc.get(acc)
        if out is None:
            continue
        o_sec, o_amt, o_id, o_ts = out
        i = bisect_right(o_sec, in_sec)            # strictly after the inbound transfer
        while i < len(o_sec) and o_sec[i] - in_sec <= window_s:
            if o_amt[i] >= ratio * in_amt:
                events.append({
                    "account": acc, "in_txn": in_id, "out_txn": o_id[i],
                    "in_amount": float(in_amt), "out_amount": float(o_amt[i]),
                    "minutes": round(float(o_sec[i] - in_sec) / 60.0, 1),
                    "out_ts": pd.Timestamp(o_ts[i]),
                })
                break  # one flag per inbound event is enough
            i += 1
    return events


def detect_rapid_passthrough(df: pd.DataFrame, result: DetectionResult) -> None:
    for ev in find_passthrough_events(df):
        result.account_flags[ev["account"]].append(PatternFlag(
            pattern="rapid_passthrough",
            evidence={k: ev[k] for k in ("in_txn", "out_txn", "in_amount", "out_amount", "minutes")},
            detected_at=ev["out_ts"],
        ))
        result.flagged_txn_ids[ev["out_txn"]] = (
            f"Rapid pass-through: sent out {ev['minutes']} min after receiving funds"
        )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_all_detectors(df: pd.DataFrame) -> DetectionResult:
    """df must have columns: txn_id, sender_account, receiver_account, amount,
    timestamp (pandas datetime64), device_id, status. Only 'successful' rows
    should be passed in - failed/pending/reversed transactions aren't signal."""
    result = DetectionResult()
    detect_fan_in(df, result)
    detect_cycles(df, result)
    detect_shared_devices(df, result)
    detect_rapid_passthrough(df, result)
    return result


# ---------------------------------------------------------------------------
# Risk scoring
# ---------------------------------------------------------------------------

PATTERN_WEIGHTS = {
    "fan_in_collector": 45,
    "fan_in_feeder": 15,
    "cycle_member": 40,
    "shared_device_member": 20,
    "rapid_passthrough": 30,
    "statistical_anomaly": 35,
}

# Patterns produced by the four rule detectors (used for neighbour propagation).
RULE_PATTERNS = {"fan_in_collector", "fan_in_feeder", "cycle_member",
                 "shared_device_member", "rapid_passthrough"}

NEIGHBOR_BONUS_PER_FLAGGED = 5
NEIGHBOR_BONUS_CAP = 20
AMOUNT_ANOMALY_BONUS = 10


def risk_level_for_score(score: float) -> str:
    if score >= settings.risk_band_critical:
        return "critical"
    if score >= settings.risk_band_high:
        return "high"
    if score >= settings.risk_band_medium:
        return "medium"
    return "low"


def compute_account_scores(
    df: pd.DataFrame,
    result: DetectionResult,
    ml_scores: Optional[Dict[str, dict]] = None,
) -> Dict[str, dict]:
    """
    Computes final risk scores per account (0-100 scale).

    Blends deterministic rule scores with supervised fraud probability and
    unsupervised anomaly scores (when ml_scores is provided):
    - Rule flags are never diluted by low ML probability (high-water mark).
    - Unsupervised anomalies elevate accounts that escaped rule detection.

    ml_scores should hold OUT-OF-FOLD probabilities (see ml.predict_risk_and_anomalies)
    so an account is never scored by a model that was trained on its own label.
    """
    # base score from own patterns (each pattern type counts once per account)
    base_scores: Dict[str, float] = defaultdict(float)
    patterns_by_account: Dict[str, Set[str]] = defaultdict(set)

    for acc, flags in result.account_flags.items():
        seen_patterns: Set[str] = set()
        for f in flags:
            if f.pattern not in seen_patterns:
                base_scores[acc] += PATTERN_WEIGHTS.get(f.pattern, 0)
                seen_patterns.add(f.pattern)
        patterns_by_account[acc] = seen_patterns

    # amount anomaly: accounts that ever sent a top-1%-sized transaction
    if len(df) > 0:
        p99 = df["amount"].quantile(0.99)
        anomaly_accounts = set(df.loc[df["amount"] >= p99, "sender_account"])
    else:
        anomaly_accounts = set()
    for acc in anomaly_accounts:
        base_scores[acc] += AMOUNT_ANOMALY_BONUS
        patterns_by_account[acc].add("large_amount_anomaly")

    # accounts hit by a real rule detector - only these spread risk to neighbours
    rule_flagged = {
        acc for acc, pats in patterns_by_account.items() if pats & RULE_PATTERNS
    }

    # undirected adjacency for neighbour propagation
    adjacency: Dict[str, Set[str]] = defaultdict(set)
    for s, r in zip(df["sender_account"], df["receiver_account"]):
        adjacency[s].add(r)
        adjacency[r].add(s)

    final: Dict[str, dict] = {}
    all_accounts = set(base_scores) | set(df["sender_account"]) | set(df["receiver_account"])
    if ml_scores:
        all_accounts |= set(ml_scores)

    for acc in all_accounts:
        rule_score = base_scores.get(acc, 0.0)
        flagged_neighbors = sum(1 for n in adjacency.get(acc, ()) if n in rule_flagged)
        rule_score += min(flagged_neighbors * NEIGHBOR_BONUS_PER_FLAGGED, NEIGHBOR_BONUS_CAP)
        rule_score = min(rule_score, 100.0)

        ml_info = ml_scores.get(acc) if ml_scores else None
        if ml_info is not None:
            p_ml = ml_info.get("ml_fraud_prob", 0.0)
            a_score = ml_info.get("anomaly_score", 0.0)
            is_anom = ml_info.get("is_anomaly", False)

            s_ml = p_ml * 100.0
            s_anom = a_score * 100.0
            ml_blend = 0.70 * s_ml + 0.30 * s_anom

            if rule_score > 0:
                # high-water mark: strong rule findings are never degraded by the ML score
                score = max(rule_score, 0.60 * rule_score + 0.40 * ml_blend)
            elif is_anom:
                # zero rule flags but caught by the Isolation Forest
                score = max(35.0, 0.60 * s_ml + 0.40 * s_anom)
            else:
                score = 0.20 * s_ml
        else:
            score = rule_score

        score = min(score, 100.0)
        final[acc] = {
            "score": round(score, 1),
            "level": risk_level_for_score(score),
            "patterns": sorted(patterns_by_account.get(acc, [])),
            "rule_score": round(rule_score, 1),
            "ml_fraud_prob": round(ml_info.get("ml_fraud_prob", 0.0), 4) if ml_info else 0.0,
            "anomaly_score": round(ml_info.get("anomaly_score", 0.0), 4) if ml_info else 0.0,
        }
    return final
