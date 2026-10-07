"""Unit tests for the detectors. Pure pandas/networkx - no database needed."""
import random
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from app.detection import (
    DetectionResult, _best_time_ordered_walk, detect_cycles, detect_fan_in,
    detect_shared_devices, find_passthrough_events, run_all_detectors, sliding_window_stats,
)

T0 = datetime(2026, 8, 10, 9, 0, 0)


def txns(rows):
    """rows: (sender, receiver, amount, minutes_after_T0[, device])"""
    recs = []
    for i, r in enumerate(rows):
        s, rc, amt, mins = r[:4]
        recs.append({
            "txn_id": f"T{i}", "sender_account": s, "receiver_account": rc, "amount": float(amt),
            "timestamp": T0 + timedelta(minutes=mins), "device_id": r[4] if len(r) > 4 else f"D{i}",
            "status": "successful",
        })
    return pd.DataFrame(recs)


# ---------------------------------------------------------------- cycles

def test_cycle_found_whatever_node_networkx_starts_from():
    """Regression: the time-order check used to pass for only ONE rotation of each ring."""
    ring = ["A", "B", "C", "D"]
    edges = {}
    for i in range(4):
        u, v = ring[i], ring[(i + 1) % 4]
        edges[(u, v)] = [(float(i * 900), pd.Timestamp(T0), f"T{i}")]   # A->B, B->C, C->D, D->A in order
    for r in range(4):
        rotated = ring[r:] + ring[:r]
        assert _best_time_ordered_walk(rotated, edges, 24 * 3600) is not None, f"rotation {r} missed"


def test_detect_cycles_flags_every_member():
    df = txns([("A", "B", 100_000, 0), ("B", "C", 95_000, 15), ("C", "D", 90_000, 30), ("D", "A", 85_000, 45)])
    res = DetectionResult()
    detect_cycles(df, res)
    assert set(res.account_flags) == {"A", "B", "C", "D"}
    assert all(f.pattern == "cycle_member" for fl in res.account_flags.values() for f in fl)
    assert len(res.flagged_txn_ids) == 4


def test_cycle_that_cannot_be_time_ordered_is_ignored():
    df = txns([("A", "B", 100_000, 100), ("B", "C", 95_000, 50), ("C", "A", 90_000, 10)])
    res = DetectionResult()
    detect_cycles(df, res)
    assert not res.account_flags


def test_cycle_slower_than_window_is_ignored():
    df = txns([("A", "B", 100_000, 0), ("B", "C", 95_000, 15 * 60), ("C", "A", 90_000, 30 * 60)])  # 30h span
    res = DetectionResult()
    detect_cycles(df, res)
    assert not res.account_flags


def test_small_value_cycles_ignored():
    df = txns([("A", "B", 1_000, 0), ("B", "C", 1_000, 5), ("C", "A", 1_000, 10)])
    res = DetectionResult()
    detect_cycles(df, res)
    assert not res.account_flags


# ---------------------------------------------------------------- fan-in

def test_fan_in_flags_collector_and_all_feeders():
    rows = [(f"F{i}", "MULE", 50_000, i * 10) for i in range(8)]
    res = DetectionResult()
    detect_fan_in(txns(rows), res)
    assert {f.pattern for f in res.account_flags["MULE"]} == {"fan_in_collector"}
    assert sum(1 for a in res.account_flags if a.startswith("F")) == 8


def test_fan_in_not_triggered_when_senders_spread_over_days():
    rows = [(f"F{i}", "SHOP", 50_000, i * 24 * 60) for i in range(8)]
    res = DetectionResult()
    detect_fan_in(txns(rows), res)
    assert not res.account_flags


def test_sliding_window_matches_brute_force():
    rng = random.Random(7)
    for _ in range(50):
        n = rng.randint(1, 40)
        ts = np.array(sorted(rng.uniform(0, 100_000) for _ in range(n)))
        senders = [f"S{rng.randint(0, 9)}" for _ in range(n)]
        amts = [rng.uniform(1, 100) for _ in range(n)]
        cnt, s, e, amt = sliding_window_stats(ts, senders, amts, 21_600)
        best_cnt, best_amt = 0, 0.0
        for i in range(n):
            j = max(k for k in range(i, n) if ts[k] - ts[i] <= 21_600)
            best_cnt = max(best_cnt, len(set(senders[i:j + 1])))
            best_amt = max(best_amt, sum(amts[i:j + 1]))
        assert cnt == best_cnt and amt == pytest.approx(best_amt)
        assert len(set(senders[s:e + 1])) == cnt


# ---------------------------------------------------------------- shared device

def test_shared_device_threshold_and_normal_pairs():
    rows = [(f"U{i}", "X", 10_000, i, "BADDEV") for i in range(5)] + \
           [("P1", "X", 10_000, 0, "FAMILY"), ("P2", "X", 10_000, 1, "FAMILY")]   # a family pair stays below threshold
    res = DetectionResult()
    flagged = detect_shared_devices(txns(rows), res)
    assert set(flagged) == {"BADDEV"} and len(flagged["BADDEV"]) == 5
    assert "FAMILY" not in res.device_flags


# ---------------------------------------------------------------- pass-through

def test_passthrough_needs_inbound_then_outbound_in_order_and_materiality():
    df = txns([("S", "M", 200_000, 0), ("M", "T", 190_000, 10)])
    ev = find_passthrough_events(df)
    assert len(ev) == 1 and ev[0]["account"] == "M" and ev[0]["minutes"] == 10.0

    assert not find_passthrough_events(txns([("M", "T", 190_000, 0), ("S", "M", 200_000, 10)]))   # out BEFORE in
    assert not find_passthrough_events(txns([("S", "M", 200_000, 0), ("M", "T", 190_000, 90)]))   # too slow
    assert not find_passthrough_events(txns([("S", "M", 5_000, 0), ("M", "T", 5_000, 5)]))        # below materiality floor
    assert not find_passthrough_events(txns([("S", "M", 200_000, 0), ("M", "T", 20_000, 5)]))     # only 10% passed on


def test_chain_endpoints_cannot_trigger_but_intermediates_do():
    df = txns([("O", "I1", 500_000, 0), ("I1", "I2", 480_000, 5), ("I2", "E", 460_000, 11)])
    res = run_all_detectors(df)
    assert set(res.account_flags) == {"I1", "I2"}
