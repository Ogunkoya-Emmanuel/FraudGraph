"""
Reproducible accuracy check against the planted ground truth.

    python -m app.evaluate

Needs NO database - it runs the same pipeline that seed.py persists, straight
from the CSVs, and prints per-pattern recall, false positives and the ML
numbers. Quote THESE numbers (not hand-written ones) in the README and pitch.

Honest framing: the data is synthetic and the negatives are easy, so these
figures show the detectors work as designed - they are not real-world accuracy.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from app.detection import RULE_PATTERNS
from app.pipeline import run_pipeline

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# ground-truth label -> the detector pattern that should fire for it
EXPECTED = {
    "fan_in_collector": "fan_in_collector",
    "fan_in_feeder": "fan_in_feeder",
    "cycle_member": "cycle_member",
    "shared_device_member": "shared_device_member",
    "rapid_passthrough": "rapid_passthrough",
}


def load():
    accounts = pd.read_csv(DATA_DIR / "accounts.csv", dtype={"phone": str, "id_number": str})
    txns = pd.read_csv(DATA_DIR / "transactions.csv", parse_dates=["timestamp"])
    gt = pd.read_csv(DATA_DIR / "ground_truth.csv")
    return accounts, txns, gt


def pct(n: int, d: int) -> str:
    return f"{n}/{d} ({(100 * n / d if d else 0):.0f}%)"


def main() -> None:
    accounts, txns, gt = load()
    out = run_pipeline(accounts, txns, gt, save_model_artifacts=False, use_gemini=False)

    planted_acc = gt[gt["entity_type"] == "account"]
    planted_ids = set(planted_acc["entity_id"])
    all_ids = set(accounts["account_id"])
    normal_ids = all_ids - planted_ids

    print("=" * 66)
    print("FraudGraph evaluation on the bundled SYNTHETIC dataset")
    print("=" * 66)
    print(f"accounts: {len(all_ids)}   transactions: {len(txns)}   "
          f"planted fraud accounts: {len(planted_ids)}   normal accounts: {len(normal_ids)}")

    print("\n1) Rule detectors - recall per planted pattern (the matching detector fired)")
    for label, pattern in EXPECTED.items():
        ids = set(planted_acc.loc[planted_acc["fraud_pattern"] == label, "entity_id"])
        hit = {a for a in ids if any(f.pattern == pattern for f in out.result.account_flags.get(a, []))}
        print(f"   {label:22s} {pct(len(hit), len(ids))}")

    # whole rings, not just accounts
    cyc = planted_acc[planted_acc["fraud_pattern"] == "cycle_member"].groupby("ring_id")["entity_id"].apply(set)
    rings_found = sum(
        all(any(f.pattern == "cycle_member" for f in out.result.account_flags.get(a, [])) for a in members)
        for members in cyc
    )
    print(f"   {'cycle rings (whole ring)':22s} {pct(rings_found, len(cyc))}")

    planted_dev = set(gt.loc[gt["entity_type"] == "device", "entity_id"])
    print(f"   {'shared devices':22s} {pct(len(planted_dev & set(out.result.device_flags)), len(planted_dev))}")

    rule_flagged = {a for a, fl in out.result.account_flags.items()
                    if any(f.pattern in RULE_PATTERNS for f in fl)}
    fp = rule_flagged - planted_ids
    print(f"\n2) Rule detectors overall: caught {pct(len(rule_flagged & planted_ids), len(planted_ids))} "
          f"planted accounts; false positives: {len(fp)} of {len(normal_ids)} normal accounts")

    print("\n3) Final hybrid risk score (rules + ML + anomaly)")
    for label, levels in (("medium or above", {"medium", "high", "critical"}), ("high or above", {"high", "critical"})):
        flagged = {a for a, s in out.scores.items() if s["level"] in levels and a in all_ids}
        print(f"   {label:16s} caught {pct(len(flagged & planted_ids), len(planted_ids))} planted; "
              f"{len(flagged - planted_ids)} normal accounts flagged "
              f"({100 * len(flagged - planted_ids) / max(len(normal_ids), 1):.1f}% of normal)")
    dist = pd.Series([s["level"] for a, s in out.scores.items() if a in all_ids]).value_counts()
    print("   risk distribution:", {k: int(dist.get(k, 0)) for k in ("low", "medium", "high", "critical")})

    anom = [a for a in out.alerts if a["pattern"] == "statistical_anomaly"]
    anom_planted = sum(a["entity_id"] in planted_ids for a in anom)
    print(f"   Isolation Forest surfaced {len(anom)} accounts no rule caught "
          f"({anom_planted} planted, {len(anom) - anom_planted} normal) - it always flags its top 8% by design")

    print("\n4) ML layer (synthetic data - a pipeline demo, NOT real-world accuracy)")
    ids = list(out.ml_results)
    y = np.array([1 if a in planted_ids else 0 for a in ids])
    oof = np.array([out.ml_results[a]["ml_fraud_prob"] for a in ids])
    print(f"   Random Forest {out.ml_metrics.get('cv_folds')}-fold cross-validated AUC: {out.ml_metrics.get('cv_roc_auc')}")
    print(f"   Shown ml_score is OUT-OF-FOLD: planted avg {oof[y == 1].mean():.3f}, normal avg {oof[y == 0].mean():.3f}"
          f"  (AUC {roc_auc_score(y, oof):.4f})")
    print("   Labels come from the same patterns the features encode, so a high AUC is expected here.")

    print(f"\n5) Alerts generated: {len(out.alerts)}")
    print("=" * 66)


if __name__ == "__main__":
    main()
