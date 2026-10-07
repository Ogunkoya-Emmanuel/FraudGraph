"""
End-to-end checks on the bundled synthetic dataset. These pin the numbers quoted in the README to
the code: if a change breaks detection, or the README drifts, this fails.
"""
from pathlib import Path
from unittest import mock

import pandas as pd
import pytest

from app import explain, seed
from app.config import settings
from app.detection import PatternFlag, RULE_PATTERNS
from app.evaluate import load
from app.ml import predict_risk_and_anomalies
from app.pipeline import run_pipeline


@pytest.fixture(scope="module")
def data():
    return load()


@pytest.fixture(scope="module")
def out(data):
    accounts, txns, gt = data
    return run_pipeline(accounts, txns, gt, save_model_artifacts=False, use_gemini=False)


def test_every_planted_pattern_is_detected_with_no_rule_false_positives(data, out):
    accounts, _, gt = data
    planted = gt[gt["entity_type"] == "account"]
    expected = {"fan_in_collector", "fan_in_feeder", "cycle_member", "shared_device_member", "rapid_passthrough"}
    for label in expected:
        ids = set(planted.loc[planted["fraud_pattern"] == label, "entity_id"])
        hit = {a for a in ids if any(f.pattern == label for f in out.result.account_flags.get(a, []))}
        assert hit == ids, f"{label}: {len(hit)}/{len(ids)}"
    rule_flagged = {a for a, fl in out.result.account_flags.items() if any(f.pattern in RULE_PATTERNS for f in fl)}
    assert rule_flagged == set(planted["entity_id"])


def test_all_planted_cycle_rings_found(data, out):
    _, _, gt = data
    rings = gt[gt["fraud_pattern"] == "cycle_member"].groupby("ring_id")["entity_id"].apply(set)
    assert len(rings) == 3
    for members in rings:
        assert all(any(f.pattern == "cycle_member" for f in out.result.account_flags[a]) for a in members)


def test_dataset_is_database_safe(data):
    accounts, txns, _ = data
    devices = pd.read_csv(Path(__file__).resolve().parent.parent / "data" / "devices.csv")
    assert set(txns["device_id"].dropna()) <= set(devices["device_id"]), "dangling device ids break PostgreSQL"
    assert accounts["phone"].str.startswith("0").all()


def test_validate_and_complete_creates_missing_devices(data):
    accounts, txns, _ = data
    devices = pd.DataFrame({"device_id": ["ONLY_ONE"], "device_type": ["android"]})
    completed = seed.validate_and_complete(accounts, devices, txns)
    assert set(txns["device_id"].dropna()) <= set(completed["device_id"])
    bad = txns.copy()
    bad.loc[bad.index[0], "sender_account"] = "ACC_DOES_NOT_EXIST"
    with pytest.raises(ValueError):
        seed.validate_and_complete(accounts, devices, bad)


def test_ml_scores_are_out_of_fold_not_memorised(data):
    from app.features import extract_account_features
    from app.ml import train_models
    accounts, txns, gt = data
    X = extract_account_features(txns, accounts)
    bundle = train_models(X, gt)
    oof = predict_risk_and_anomalies(X, bundle, use_out_of_fold=True)
    in_sample = predict_risk_and_anomalies(X, bundle, use_out_of_fold=False)
    planted = set(gt.loc[gt["entity_type"] == "account", "entity_id"])
    avg = lambda d: sum(d[a]["ml_fraud_prob"] for a in planted) / len(planted)
    assert avg(in_sample) > avg(oof), "in-sample scores should look better than honest out-of-fold ones"
    assert all(oof[a]["ml_fraud_prob"] == round(bundle["oof_probs"][a], 4) for a in X.index)


def test_alert_detected_at_comes_from_transactions_not_seed_time(data, out):
    _, txns, _ = data
    first, last = txns["timestamp"].min(), txns["timestamp"].max()
    stamps = {a["detected_at"] for a in out.alerts}
    assert len(stamps) > 20, "alerts must have real, varied timestamps"
    assert all(first <= pd.Timestamp(s) <= last for s in stamps)
    assert len({a["alert_id"] for a in out.alerts}) == len(out.alerts)


def test_alert_json_fields_contain_only_builtin_types(out):
    for a in out.alerts:
        for key in ("explanation", "related_transactions", "connected_entities"):
            assert all(type(x) is str for x in a[key])


def test_no_gemini_means_no_network_and_rule_based_source(out):
    assert not out.gemini_used and all(a["explanation_source"] == "rule_based" for a in out.alerts)


# ---------------------------------------------------------------- Gemini wrapper (requests is mocked)

FLAGS = [PatternFlag("fan_in_feeder", {"collector": "ACCSECRET1", "txn_id": "T1"})]


def _fake_post(text, captured):
    def post(url, headers=None, json=None, timeout=None):
        captured["prompt"] = json["contents"][0]["parts"][0]["text"]
        r = mock.Mock(status_code=200)
        r.raise_for_status = lambda: None
        r.json = lambda: {"candidates": [{"content": {"parts": [{"text": text}]}}]}
        return r
    return post


@pytest.fixture()
def gemini_on():
    settings.gemini_api_key = "test-key"
    explain.reset_gemini_state()
    yield
    settings.gemini_api_key = ""
    explain.reset_gemini_state()


def test_gemini_never_sees_real_account_ids(gemini_on):
    seen = {}
    reply = '["Sent funds into ACCOUNT_A as part of a fan-in."]'
    with mock.patch.object(explain.requests, "post", _fake_post(reply, seen)):
        sentences, source = explain.build_explanation(FLAGS)
    assert source == "gemini" and "ACCSECRET1" not in seen["prompt"] and "ACCOUNT_A" in seen["prompt"]
    assert "ACCSECRET1" in sentences[0]            # restored for the investigator


def test_gemini_answer_with_invented_numbers_is_rejected(gemini_on):
    flags = [PatternFlag("rapid_passthrough", {"in_amount": 100000.0, "out_amount": 95000.0, "minutes": 5.0,
                                                 "in_txn": "a", "out_txn": "b"})]
    with mock.patch.object(explain.requests, "post", _fake_post('["Moved \\u20a6999,999 in 2 minutes."]', {})):
        _, source = explain.build_explanation(flags)
    assert source == "rule_based"


def test_gemini_is_switched_off_after_repeated_failures(gemini_on):
    calls = []

    def boom(*a, **k):
        calls.append(1)
        raise ConnectionError("offline")

    with mock.patch.object(explain.requests, "post", boom):
        for _ in range(20):
            explain.build_explanation(FLAGS)
    assert len(calls) == 3
