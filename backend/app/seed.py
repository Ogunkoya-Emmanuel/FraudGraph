"""
One-time data load + detection pipeline.

Run with:  python -m app.seed

This reads the CSVs in ./data, runs the whole compute pipeline (app/pipeline.py:
four rule detectors, ML features, out-of-fold Random Forest, Isolation Forest,
hybrid scoring, alerts + explanations) and ONLY THEN rebuilds the database
tables and writes the results in a single transaction. If anything in the
compute step fails, the existing database is left untouched.

The API itself never recomputes this at request time - it just reads what this
script wrote, which is why the API stays fast.

Re-running this script drops and rebuilds all tables from scratch, so it's
safe to run again after editing detection thresholds in config.py.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from app.database import Base, SessionLocal, engine
from app.explain import gemini_is_active
from app.models import Account, Alert, Device, Transaction
from app.pipeline import device_severity, run_pipeline

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def clean(value):
    """NaN/NaT -> None so databases get a real NULL (PostgreSQL would store the string 'NaN')."""
    return None if pd.isna(value) else value


def load_csvs():
    # phone / id_number MUST be read as text, or pandas drops the leading 0 of "0803..."
    accounts_df = pd.read_csv(DATA_DIR / "accounts.csv", dtype={"phone": str, "id_number": str})
    devices_df = pd.read_csv(DATA_DIR / "devices.csv")
    txns_df = pd.read_csv(DATA_DIR / "transactions.csv", parse_dates=["timestamp"])
    gt_df = pd.read_csv(DATA_DIR / "ground_truth.csv")
    return accounts_df, devices_df, txns_df, gt_df


def validate_and_complete(accounts_df, devices_df, txns_df) -> pd.DataFrame:
    """
    Make the data safe for a database that enforces foreign keys (PostgreSQL does, SQLite
    silently ignores them). Returns the devices table, extended with a Device row for every
    device_id that transactions reference but devices.csv does not list.
    """
    for name, df, col in (("accounts", accounts_df, "account_id"),
                          ("devices", devices_df, "device_id"),
                          ("transactions", txns_df, "txn_id")):
        dupes = df[col].duplicated().sum()
        if dupes:
            raise ValueError(f"{name}.csv has {dupes} duplicate {col} values")

    known_accounts = set(accounts_df["account_id"])
    used_accounts = set(txns_df["sender_account"]) | set(txns_df["receiver_account"])
    missing_accounts = used_accounts - known_accounts
    if missing_accounts:
        raise ValueError(
            f"{len(missing_accounts)} account ids appear in transactions.csv but not in accounts.csv "
            f"(e.g. {sorted(missing_accounts)[:3]}). PostgreSQL would reject these rows."
        )

    used_devices = set(txns_df["device_id"].dropna())
    missing_devices = sorted(used_devices - set(devices_df["device_id"]))
    if missing_devices:
        print(f"  note: {len(missing_devices)} device ids in transactions.csv were missing from "
              f"devices.csv - creating placeholder Device rows for them.")
        extra = pd.DataFrame({"device_id": missing_devices, "device_type": "unknown"})
        devices_df = pd.concat([devices_df, extra], ignore_index=True)
    return devices_df


def rebuild_schema():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def main():
    print("Loading CSVs...")
    accounts_df, devices_df, txns_df, gt_df = load_csvs()
    devices_df = validate_and_complete(accounts_df, devices_df, txns_df)

    print(f"  accounts:     {len(accounts_df)}")
    print(f"  devices:      {len(devices_df)}")
    print(f"  transactions: {len(txns_df)}")
    print(f"  ground truth: {len(gt_df)} planted entities")

    print("Running detectors, ML models, scoring and alert generation...")
    print(f"  Gemini explanations: {'on' if gemini_is_active() else 'off (rule-based explanations only)'}")
    out = run_pipeline(accounts_df, txns_df, gt_df, save_model_artifacts=True)
    print(f"  Rule detectors flagged {len(out.result.account_flags) - out.anomalies_added} accounts "
          f"and {len(out.result.device_flags)} devices.")
    print(f"  Isolation Forest surfaced {out.anomalies_added} extra statistical anomalies (no rule flags).")
    print(f"  Random Forest cross-validated ROC-AUC: {out.ml_metrics.get('cv_roc_auc')} "
          f"(synthetic data - a pipeline demo, not real-world accuracy)")

    print("Rebuilding schema...")
    rebuild_schema()

    db = SessionLocal()
    try:
        print("Writing accounts and devices...")
        db.add_all([
            Account(
                account_id=r.account_id, owner_name=r.owner_name,
                phone=clean(r.phone), id_number=clean(r.id_number),
                city=clean(r.city), account_type=clean(r.account_type),
                opened_date=clean(r.opened_date),
                risk_score=out.scores.get(r.account_id, {}).get("score", 0.0),
                risk_level=out.scores.get(r.account_id, {}).get("level", "low"),
                flagged_patterns=out.scores.get(r.account_id, {}).get("patterns", []),
                ml_score=round(out.scores.get(r.account_id, {}).get("ml_fraud_prob", 0.0) * 100.0, 1),
                anomaly_score=round(out.scores.get(r.account_id, {}).get("anomaly_score", 0.0) * 100.0, 1),
            )
            for r in accounts_df.itertuples(index=False)
        ])
        db.add_all([
            Device(
                device_id=r.device_id, device_type=clean(r.device_type),
                risk_level=(device_severity(out.result.device_flags[r.device_id][0].evidence["account_count"])
                            if r.device_id in out.result.device_flags else "low"),
                flagged=r.device_id in out.result.device_flags,
                linked_account_count=(out.result.device_flags[r.device_id][0].evidence["account_count"]
                                      if r.device_id in out.result.device_flags else 0),
            )
            for r in devices_df.itertuples(index=False)
        ])
        db.flush()  # parents first, so foreign keys are satisfied

        print("Writing transactions...")
        flagged = out.result.flagged_txn_ids
        db.add_all([
            Transaction(
                txn_id=r.txn_id, sender_account=r.sender_account, receiver_account=r.receiver_account,
                amount=float(r.amount), timestamp=r.timestamp.to_pydatetime(),
                channel=clean(r.channel), device_id=clean(r.device_id),
                ip_address=clean(r.ip_address), location=clean(r.location), status=r.status,
                flagged=r.txn_id in flagged, flagged_reason=flagged.get(r.txn_id),
            )
            for r in txns_df.itertuples(index=False)
        ])
        db.flush()

        print("Writing alerts...")
        db.add_all([
            Alert(
                alert_id=a["alert_id"], entity_id=a["entity_id"], entity_type=a["entity_type"],
                pattern=a["pattern"], severity=a["severity"], detected_at=a["detected_at"],
                status="new", feedback=None, updated_at=None,
                explanation=a["explanation"], explanation_source=a["explanation_source"],
                related_transactions=a["related_transactions"], connected_entities=a["connected_entities"],
            )
            for a in out.alerts
        ])
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    anom = sum(1 for a in out.alerts if a["pattern"] == "statistical_anomaly")
    print(f"Done. {len(out.alerts)} alerts generated ({len(out.alerts) - anom} rule-based, {anom} statistical anomaly).")
    print(f"Gemini used for at least one explanation: {out.gemini_used}")
    if not out.gemini_used:
        print("(All explanations used the rule-based fallback - "
              "set GEMINI_API_KEY in .env to enable Gemini polish.)")


if __name__ == "__main__":
    main()
