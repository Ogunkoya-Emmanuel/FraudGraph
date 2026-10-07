"""
Machine Learning layer for FraudGraph.

Combines two complementary modeling paradigms:
1. Supervised Random Forest Classifier:
   Trained on ground_truth.csv labels using genuine behavioral and topological
   features. Replaces manual point-weights with calibrated probability of fraud.
2. Unsupervised Isolation Forest:
   Trained on the population feature matrix. Catches unknown, zero-day anomalies
   and suspicious outliers that do not match existing deterministic rule definitions.

Serializes artifacts to backend/models/fraud_models.joblib (only load model files you trained yourself:
joblib files are pickles).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, List, Optional

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold

logger = logging.getLogger("fraudgraph.ml")

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODELS_DIR / "fraud_models.joblib"


def explain_account_anomaly(row: pd.Series, normal_stats: dict) -> List[str]:
    """
    Generates human-readable, domain-relevant bullet reasons explaining why
    an account was flagged as an anomaly by the unsupervised Isolation Forest.
    """
    reasons: List[str] = []
    medians = normal_stats.get("medians", {})

    shared_users = row.get("shared_device_max_users", 1)
    if shared_users >= 4:
        reasons.append(f"transacted from hardware shared with {int(shared_users) - 1} other distinct accounts")

    window_senders = row.get("max_senders_6h_window", 0)
    if window_senders >= 4:
        reasons.append(f"abnormal burst of {int(window_senders)} distinct senders within a 6-hour window")

    passthrough_cnt = row.get("rapid_passthrough_count", 0)
    if passthrough_cnt >= 1:
        reasons.append(f"{int(passthrough_cnt)} rapid pass-through transfers (funds disbursed within 45 mins of receipt)")

    flow_ratio = row.get("flow_ratio", 0)
    in_amount = row.get("in_total_amount", 0)
    if flow_ratio >= 0.85 and in_amount >= 100_000:
        reasons.append(f"high turnover ratio ({flow_ratio:.0%} of received funds pushed outbound)")

    out_avg = row.get("out_avg_amount", 0)
    med_out_avg = medians.get("out_avg_amount", 0)
    if med_out_avg > 0 and out_avg >= med_out_avg * 3 and out_avg >= 50_000:
        reasons.append(f"average transaction size (₦{out_avg:,.2f}) is 3x+ above population baseline")

    total_txns = row.get("total_txn_count", 0)
    med_txns = medians.get("total_txn_count", 0)
    if med_txns > 0 and total_txns >= med_txns * 2.5 and total_txns >= 15:
        reasons.append(f"unusual transaction velocity ({int(total_txns)} transfers) compared to normal baseline")

    night_frac = row.get("night_txn_fraction", 0)
    if night_frac >= 0.40 and total_txns >= 3:
        reasons.append(f"{night_frac:.0%} of activity executed during late-night hours (00:00–06:00)")

    if not reasons:
        reasons.append("multivariate anomaly across counterparty entropy, transfer velocity, and volume")

    return reasons


ISO_CONTAMINATION = 0.08  # Isolation Forest always surfaces the ~8% most unusual accounts for review


def train_models(
    X: pd.DataFrame,
    ground_truth_df: pd.DataFrame,
) -> dict:
    """
    Trains the Random Forest supervised classifier and Isolation Forest anomaly detector.

    Returns a dict bundle containing models, feature names, baseline statistics,
    evaluation metrics AND the out-of-fold fraud probability for every training
    account ("oof_probs"). Those out-of-fold values are what the app must show and
    score with: each one comes from a model that never saw that account's label.
    Scoring accounts with the final model fitted on all labels would just be
    memorisation (planted accounts ~0.99, normal ones ~0.00).

    IMPORTANT caveat for presentation: the labels come from the same patterns the
    features encode, on synthetic data, so the AUC demonstrates a working pipeline,
    not real-world accuracy.
    """
    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Target vector y from ground_truth
    planted_accounts = set(
        ground_truth_df[ground_truth_df["entity_type"] == "account"]["entity_id"]
    )
    y = np.array([1 if acc in planted_accounts else 0 for acc in X.index])
    n_pos, n_neg = int(y.sum()), int((y == 0).sum())

    logger.info("Training supervised Random Forest classifier (%d positive / %d total)...", n_pos, len(y))

    def _new_rf() -> RandomForestClassifier:
        return RandomForestClassifier(
            n_estimators=100, max_depth=8, random_state=42, class_weight="balanced",
        )

    rf = _new_rf()
    oof_probs = np.zeros(len(y))
    cv_auc = None

    n_splits = min(5, n_pos, n_neg)
    if n_splits >= 2:
        # Out-of-fold predictions via stratified K-fold cross-validation
        cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
        for train_idx, val_idx in cv.split(X, y):
            rf_fold = _new_rf()
            rf_fold.fit(X.iloc[train_idx], y[train_idx])
            oof_probs[val_idx] = rf_fold.predict_proba(X.iloc[val_idx])[:, 1]
        cv_auc = float(roc_auc_score(y, oof_probs))
        logger.info("Random Forest %d-fold cross-validation ROC-AUC: %.4f", n_splits, cv_auc)
        rf.fit(X, y)  # final model, used only for accounts that were not in training
    else:
        logger.warning("Not enough labelled accounts for cross-validation (%d pos / %d neg); "
                       "supervised scores will be 0.", n_pos, n_neg)
        rf = None

    # 2. Train unsupervised Isolation Forest on full feature matrix (no labels used)
    logger.info("Training unsupervised Isolation Forest anomaly detector...")
    iso = IsolationForest(
        n_estimators=100,
        contamination=ISO_CONTAMINATION,
        random_state=42,
    )
    iso.fit(X)

    # Normal population statistics for deviation baselines
    normal_mask = (y == 0)
    normal_df = X[normal_mask] if normal_mask.sum() > 0 else X
    normal_stats = {
        "medians": normal_df.median().to_dict(),
        "iqrs": (normal_df.quantile(0.75) - normal_df.quantile(0.25)).to_dict(),
    }

    bundle = {
        "rf_model": rf,
        "iso_forest": iso,
        "feature_names": list(X.columns),
        "normal_stats": normal_stats,
        "oof_probs": {acc: float(p) for acc, p in zip(X.index, oof_probs)},
        "metrics": {
            "cv_roc_auc": round(cv_auc, 4) if cv_auc is not None else None,
            "cv_folds": n_splits if n_splits >= 2 else 0,
            "total_accounts": len(X),
            "fraud_count": n_pos,
            "note": "Synthetic data; labels derive from the same patterns the features encode. "
                    "Demonstrates the pipeline, not real-world accuracy.",
        },
    }
    return bundle


def save_models(bundle: dict, path: Path = MODEL_PATH) -> None:
    """Serializes the trained models bundle to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path)
    logger.info("Model artifacts saved to %s", path)


def load_models(path: Path = MODEL_PATH) -> Optional[dict]:
    """Loads the model artifacts bundle from disk if present."""
    if path.exists():
        try:
            return joblib.load(path)
        except Exception as exc:
            logger.warning("Could not load model file %s: %s", path, exc)
            return None
    return None


def get_or_train_models(
    X: pd.DataFrame,
    ground_truth_df: pd.DataFrame,
    force_retrain: bool = False,
    path: Path = MODEL_PATH,
) -> dict:
    """
    Returns existing models from disk or trains and saves them if missing/forced.
    """
    if not force_retrain:
        loaded = load_models(path)
        if loaded is not None:
            return loaded

    bundle = train_models(X, ground_truth_df)
    save_models(bundle, path)
    return bundle


def predict_risk_and_anomalies(
    X: pd.DataFrame,
    bundle: dict,
    use_out_of_fold: bool = True,
) -> Dict[str, dict]:
    """
    Generates supervised fraud probabilities and unsupervised anomaly scores.

    For accounts that were part of training, the supervised probability is the
    OUT-OF-FOLD value (from a model that never saw that account's label) when
    `use_out_of_fold` is True. Accounts unseen at training time are scored by the
    final model.

    Returns:
    Dict[account_id, {
        "ml_fraud_prob": float (0.0 to 1.0),
        "is_anomaly": bool,
        "anomaly_score": float (0.0 to 1.0),
        "anomaly_reasons": List[str]
    }]
    """
    rf: Optional[RandomForestClassifier] = bundle.get("rf_model")
    iso: IsolationForest = bundle["iso_forest"]
    normal_stats: dict = bundle["normal_stats"]
    oof: dict = bundle.get("oof_probs") or {}

    # Supervised predictions (probability of fraud)
    if rf is not None:
        rf_probs = rf.predict_proba(X)[:, 1]
    else:
        rf_probs = np.zeros(len(X))
    if use_out_of_fold and oof:
        rf_probs = np.array([oof.get(acc, p) for acc, p in zip(X.index, rf_probs)], dtype=float)

    # Unsupervised predictions & normalized scores
    raw_anom_scores = iso.decision_function(X)  # lower = more abnormal
    min_s, max_s = raw_anom_scores.min(), raw_anom_scores.max()
    denom = max_s - min_s if max_s > min_s else 1.0
    norm_anom_scores = (max_s - raw_anom_scores) / denom  # 1.0 = most anomalous

    iso_preds = iso.predict(X)  # -1 = anomaly, 1 = normal

    results: Dict[str, dict] = {}
    for idx, acc_id in enumerate(X.index):
        row = X.iloc[idx]
        is_anom = bool(iso_preds[idx] == -1)
        anom_reasons = explain_account_anomaly(row, normal_stats) if is_anom else []

        results[acc_id] = {
            "ml_fraud_prob": round(float(rf_probs[idx]), 4),
            "is_anomaly": is_anom,
            "anomaly_score": round(float(norm_anom_scores[idx]), 4),
            "anomaly_reasons": anom_reasons,
        }

    return results
