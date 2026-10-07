"""
Account-level feature extraction for FraudGraph ML models.

Transforms raw transactions and account metadata into a rich behavioral and
topological feature matrix (X) where each row represents an account.

Extracts genuine structural and behavioral signals:
- Transaction counts and flow ratios (inbound vs outbound)
- Directed network topology (in-degree, out-degree, counterparty diversity)
- Device and network usage (distinct devices/IPs, shared device co-user counts)
- Temporal velocity and burst dynamics (6-hour sliding window peaks, rapid pass-through)
- Diurnal & day-of-week distributions (night-time / weekend fractions)
"""

from __future__ import annotations

from collections import Counter
from typing import Dict, List

import numpy as np
import pandas as pd

from app.config import settings
from app.detection import _to_seconds, find_passthrough_events, sliding_window_stats

FEATURE_COLUMNS: List[str] = [
    "in_txn_count",
    "out_txn_count",
    "total_txn_count",
    "in_out_txn_ratio",
    "in_total_amount",
    "out_total_amount",
    "net_flow",
    "flow_ratio",
    "in_avg_amount",
    "out_avg_amount",
    "in_max_amount",
    "out_max_amount",
    "out_std_amount",
    "in_degree",
    "out_degree",
    "unique_counterparties",
    "counterparty_ratio",
    "distinct_devices",
    "distinct_ips",
    "shared_device_max_users",
    "max_senders_6h_window",
    "max_window_in_amount",
    "rapid_passthrough_count",
    "night_txn_fraction",
    "weekend_txn_fraction",
    "account_age_days",
]


def extract_account_features(
    transactions_df: pd.DataFrame,
    accounts_df: pd.DataFrame,
) -> pd.DataFrame:
    """
    Extracts an account-level feature matrix X from transactions and accounts.

    Parameters:
    - transactions_df: DataFrame containing at least txn_id, sender_account,
      receiver_account, amount, timestamp, status, device_id, ip_address.
    - accounts_df: DataFrame containing at least account_id, opened_date.

    Returns:
    - pd.DataFrame indexed by account_id with columns FEATURE_COLUMNS.

    The 6-hour burst window and the pass-through rule come from the SAME helpers
    and settings the rule detectors use, so features and detectors cannot drift apart.
    """
    if "status" in transactions_df.columns:
        txns = transactions_df[transactions_df["status"] == "successful"].copy()
    else:
        txns = transactions_df.copy()

    if not pd.api.types.is_datetime64_any_dtype(txns["timestamp"]):
        txns["timestamp"] = pd.to_datetime(txns["timestamp"])

    txns = txns.sort_values("timestamp")

    all_account_ids = accounts_df["account_id"].unique().tolist()
    X = pd.DataFrame(index=all_account_ids)

    # 1. Outgoing aggregations (sender_account)
    out_grp = txns.groupby("sender_account")
    X["out_txn_count"] = out_grp.size()
    X["out_total_amount"] = out_grp["amount"].sum()
    X["out_avg_amount"] = out_grp["amount"].mean()
    X["out_std_amount"] = out_grp["amount"].std().fillna(0.0)
    X["out_max_amount"] = out_grp["amount"].max()
    X["out_degree"] = out_grp["receiver_account"].nunique()
    X["distinct_devices"] = out_grp["device_id"].nunique()
    X["distinct_ips"] = out_grp["ip_address"].nunique()

    # 2. Incoming aggregations (receiver_account)
    in_grp = txns.groupby("receiver_account")
    X["in_txn_count"] = in_grp.size()
    X["in_total_amount"] = in_grp["amount"].sum()
    X["in_avg_amount"] = in_grp["amount"].mean()
    X["in_max_amount"] = in_grp["amount"].max()
    X["in_degree"] = in_grp["sender_account"].nunique()

    # Fill base numerical values
    X = X.fillna(0.0)

    # Derived volume & flow ratios
    X["total_txn_count"] = X["in_txn_count"] + X["out_txn_count"]
    X["in_out_txn_ratio"] = X["out_txn_count"] / (X["in_txn_count"] + 1.0)
    X["net_flow"] = X["in_total_amount"] - X["out_total_amount"]
    X["flow_ratio"] = X["out_total_amount"] / (X["in_total_amount"] + 1.0)
    X["unique_counterparties"] = X["in_degree"] + X["out_degree"]
    X["counterparty_ratio"] = X["unique_counterparties"] / (X["total_txn_count"] + 1.0)

    # 3. Device sharing network: for each account, the largest number of distinct
    #    accounts that have used any device it used (1 = nobody else shares it).
    dev_pairs = txns.loc[txns["device_id"].notna(), ["device_id", "sender_account"]].drop_duplicates()
    if len(dev_pairs):
        users_per_device = dev_pairs.groupby("device_id")["sender_account"].nunique()
        dev_pairs = dev_pairs.assign(n_users=dev_pairs["device_id"].map(users_per_device))
        max_co_users = dev_pairs.groupby("sender_account")["n_users"].max()
    else:
        max_co_users = pd.Series(dtype=float)
    X["shared_device_max_users"] = max_co_users.reindex(all_account_ids).fillna(1).astype(float)

    # 4. Max distinct senders and max total inbound amount in a sliding window
    window_s = settings.fanin_window_hours * 3600.0
    max_senders: Dict[str, int] = {}
    max_in_amt: Dict[str, float] = {}
    for receiver, group in in_grp:
        g = group.sort_values("timestamp")
        cnt, _, _, amt = sliding_window_stats(
            _to_seconds(g["timestamp"]), g["sender_account"].tolist(), g["amount"].tolist(), window_s
        )
        max_senders[receiver] = cnt
        max_in_amt[receiver] = amt

    X["max_senders_6h_window"] = pd.Series(max_senders, dtype=float).reindex(all_account_ids).fillna(0)
    X["max_window_in_amount"] = pd.Series(max_in_amt, dtype=float).reindex(all_account_ids).fillna(0.0)

    # 5. Rapid pass-through count - same rule (window, ratio, materiality floor) as the detector
    pt_counts = Counter(ev["account"] for ev in find_passthrough_events(txns))
    X["rapid_passthrough_count"] = pd.Series(pt_counts, dtype=float).reindex(all_account_ids).fillna(0)

    # 6. Temporal features (night 00:00-06:00, weekend) - each txn counts for both parties
    hours = txns["timestamp"].dt.hour
    is_night = hours < 6
    is_weekend = txns["timestamp"].dt.dayofweek >= 5

    def _party_counts(mask: pd.Series) -> pd.Series:
        sent = txns.loc[mask, "sender_account"].value_counts()
        recv = txns.loc[mask, "receiver_account"].value_counts()
        return sent.add(recv, fill_value=0)

    X["night_txn_fraction"] = (
        _party_counts(is_night).reindex(all_account_ids).fillna(0) / (X["total_txn_count"] + 1.0)
    ).clip(0.0, 1.0)
    X["weekend_txn_fraction"] = (
        _party_counts(is_weekend).reindex(all_account_ids).fillna(0) / (X["total_txn_count"] + 1.0)
    ).clip(0.0, 1.0)

    # 7. Account age in days relative to latest transaction in dataset
    ref_date = txns["timestamp"].max() if len(txns) > 0 else pd.Timestamp.now()
    if "opened_date" in accounts_df.columns:
        opened_dates = pd.to_datetime(accounts_df.drop_duplicates("account_id").set_index("account_id")["opened_date"])
        age_series = (ref_date - opened_dates).dt.total_seconds() / 86400.0
        X["account_age_days"] = age_series.reindex(all_account_ids).fillna(365.0)
    else:
        X["account_age_days"] = 365.0

    # Final cleanup: ensure no NaNs or Infs remain and column order is preserved
    X = X.replace([np.inf, -np.inf], 0.0).fillna(0.0).astype(float)
    return X[FEATURE_COLUMNS]
