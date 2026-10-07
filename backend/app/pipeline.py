"""
The whole FraudGraph compute pipeline, with NO database dependency.

    CSV data frames -> rule detectors -> features -> ML (out-of-fold) -> hybrid
    risk scores -> alert records

seed.py persists the output into the database; evaluate.py scores it against
the planted ground truth. Keeping this pure means the numbers a judge can
reproduce with `python -m app.evaluate` come from exactly the code path that
fills the database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

import pandas as pd

from app.detection import (
    DetectionResult, PatternFlag, compute_account_scores, run_all_detectors,
)
from app.explain import build_explanation, gemini_is_active, reset_gemini_state, rule_based_explanation
from app.features import extract_account_features
from app.ml import predict_risk_and_anomalies, save_models, train_models


def device_severity(account_count: int) -> str:
    if account_count >= 10:
        return "critical"
    if account_count >= 6:
        return "high"
    return "medium"


@dataclass
class PipelineOutput:
    successful: pd.DataFrame
    result: DetectionResult
    scores: Dict[str, dict]
    ml_results: Dict[str, dict]
    ml_metrics: dict
    alerts: List[dict] = field(default_factory=list)
    anomalies_added: int = 0
    gemini_used: bool = False


def _evidence_txn_ids(f: PatternFlag) -> List[str]:
    e = f.evidence
    if e.get("txn_ids"):
        return list(e["txn_ids"])
    if "txn_id" in e:
        return [e["txn_id"]]
    if "in_txn" in e:
        return [e["in_txn"], e["out_txn"]]
    return []


def _evidence_entities(f: PatternFlag) -> List[str]:
    e = f.evidence
    if e.get("senders"):
        return list(e["senders"])
    if "collector" in e:
        return [e["collector"]]
    if e.get("ring_members"):
        return list(e["ring_members"])
    if "device_id" in e:
        return [e["device_id"]]
    return []


def run_pipeline(
    accounts_df: pd.DataFrame,
    txns_df: pd.DataFrame,
    gt_df: pd.DataFrame,
    save_model_artifacts: bool = False,
    use_gemini: bool = True,
) -> PipelineOutput:
    reset_gemini_state()

    successful = txns_df[txns_df["status"] == "successful"].copy()

    # 1. rule-based detectors
    result = run_all_detectors(successful)

    # 2. ML layer: features -> RF (out-of-fold) + Isolation Forest
    X = extract_account_features(txns_df, accounts_df)
    bundle = train_models(X, gt_df)
    if save_model_artifacts:
        save_models(bundle)
    ml_results = predict_risk_and_anomalies(X, bundle, use_out_of_fold=True)

    # latest successful activity per account - used to timestamp statistical-anomaly alerts
    last_seen = pd.concat([
        successful[["sender_account", "timestamp"]].rename(columns={"sender_account": "acc"}),
        successful[["receiver_account", "timestamp"]].rename(columns={"receiver_account": "acc"}),
    ]).groupby("acc")["timestamp"].max()
    dataset_end = successful["timestamp"].max()

    # accounts the Isolation Forest flags that no rule caught
    anomalies_added = 0
    for acc_id, info in ml_results.items():
        if info["is_anomaly"] and acc_id not in result.account_flags:
            result.account_flags[acc_id].append(PatternFlag(
                pattern="statistical_anomaly",
                evidence={
                    "anomaly_score": info["anomaly_score"],
                    "ml_fraud_prob": info["ml_fraud_prob"],
                    "reasons": info["anomaly_reasons"],
                },
                detected_at=last_seen.get(acc_id, dataset_end),
            ))
            anomalies_added += 1

    # 3. hybrid risk scores
    scores = compute_account_scores(successful, result, ml_scores=ml_results)

    out = PipelineOutput(
        successful=successful, result=result, scores=scores, ml_results=ml_results,
        ml_metrics=bundle["metrics"], anomalies_added=anomalies_added,
    )

    # 4. alerts
    out.alerts = _build_alerts(out, dataset_end, use_gemini)
    out.gemini_used = any(a["explanation_source"] == "gemini" for a in out.alerts)
    return out


def _build_alerts(out: PipelineOutput, dataset_end: pd.Timestamp, use_gemini: bool) -> List[dict]:
    successful, result, scores = out.successful, out.result, out.scores
    drafts: List[dict] = []

    def explain(flags: List[PatternFlag]):
        if use_gemini and gemini_is_active():
            return build_explanation(flags)
        return rule_based_explanation(flags), "rule_based"

    # --- account alerts, one per (account, pattern) ---
    by_account_pattern: Dict[tuple, List[PatternFlag]] = {}
    for acc_id, flags in result.account_flags.items():
        for f in flags:
            by_account_pattern.setdefault((acc_id, f.pattern), []).append(f)

    for (acc_id, pattern), flags in by_account_pattern.items():
        sentences, source = explain(flags)
        related = sorted({tid for f in flags for tid in _evidence_txn_ids(f)})
        connected = sorted({e for f in flags for e in _evidence_entities(f) if e != acc_id})

        # statistical anomalies carry no rule evidence: show the account's biggest transfers instead
        if not related:
            mask = (successful["sender_account"] == acc_id) | (successful["receiver_account"] == acc_id)
            top = successful[mask].nlargest(5, "amount")
            related = top["txn_id"].tolist()
            if not connected:
                connected = sorted({
                    r if s == acc_id else s
                    for s, r in zip(top["sender_account"], top["receiver_account"])
                    if (r if s == acc_id else s) != acc_id
                })

        # when the pattern first completed, from the triggering transactions
        times = [f.detected_at for f in flags if f.detected_at is not None]
        detected_at = min(times) if times else dataset_end

        drafts.append({
            "entity_id": acc_id, "entity_type": "account", "pattern": pattern,
            "severity": scores.get(acc_id, {}).get("level", "low"),
            "detected_at": pd.Timestamp(detected_at).to_pydatetime(),
            "explanation": sentences, "explanation_source": source,
            "related_transactions": related, "connected_entities": connected,
        })

    # --- device alerts ---
    device_txns = successful[successful["device_id"].notna()].groupby("device_id")["txn_id"].apply(list)
    for device_id, flags in result.device_flags.items():
        sentences, source = explain(flags)
        account_count = flags[0].evidence["account_count"]
        times = [f.detected_at for f in flags if f.detected_at is not None]
        drafts.append({
            "entity_id": device_id, "entity_type": "device", "pattern": "shared_device",
            "severity": device_severity(account_count),
            "detected_at": pd.Timestamp(min(times) if times else dataset_end).to_pydatetime(),
            "explanation": sentences, "explanation_source": source,
            "related_transactions": sorted(device_txns.get(device_id, []))[:50],
            "connected_entities": list(flags[0].evidence["accounts"]),
        })

    # deterministic IDs, in chronological order (ALT-00001 = earliest)
    drafts.sort(key=lambda d: (d["detected_at"], d["entity_id"], d["pattern"]))
    for i, d in enumerate(drafts, start=1):
        d["alert_id"] = f"ALT-{i:05d}"
    return drafts
