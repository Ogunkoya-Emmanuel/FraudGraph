"""
Builds the node/edge graph returned by GET /accounts/{id}/network.

This is a lightweight BFS directly over the transactions/devices tables —
deliberately not a full in-memory graph library at request time, since the
heavy graph analysis already happened once in seed.py. This just needs to
answer "what does the neighborhood around this account look like" fast.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Set, Tuple

from sqlalchemy.orm import Session

from app.models import Account, Device, Transaction


def build_account_network(db: Session, center_account_id: str, depth: int = 1):
    visited_accounts: Set[str] = {center_account_id}
    visited_devices: Set[str] = set()
    edges: List[dict] = []
    edge_seen: Set[Tuple] = set()

    frontier = {center_account_id}
    for _ in range(max(depth, 1)):
        next_frontier: Set[str] = set()
        if not frontier:
            break

        txns = (
            db.query(Transaction)
            .filter(
                (Transaction.sender_account.in_(frontier))
                | (Transaction.receiver_account.in_(frontier))
            )
            .all()
        )

        # aggregate transaction edges by (sender, receiver) pair
        agg: Dict[Tuple[str, str], dict] = defaultdict(lambda: {"weight": 0.0, "txn_count": 0})
        for t in txns:
            key = (t.sender_account, t.receiver_account)
            agg[key]["weight"] += t.amount
            agg[key]["txn_count"] += 1
            for acc in (t.sender_account, t.receiver_account):
                if acc not in visited_accounts:
                    next_frontier.add(acc)
            if t.device_id:
                edge_key = ("device_link", t.sender_account, t.device_id)
                if edge_key not in edge_seen:
                    edge_seen.add(edge_key)
                    edges.append({
                        "source": t.sender_account, "target": t.device_id,
                        "type": "device_link", "weight": None, "txn_count": None,
                    })
                    visited_devices.add(t.device_id)

        for (sender, receiver), info in agg.items():
            edge_key = ("transaction", sender, receiver)
            if edge_key not in edge_seen:
                edge_seen.add(edge_key)
                edges.append({
                    "source": sender, "target": receiver, "type": "transaction",
                    "weight": round(info["weight"], 2), "txn_count": info["txn_count"],
                })

        visited_accounts |= next_frontier
        frontier = next_frontier

    nodes = []
    accounts = db.query(Account).filter(Account.account_id.in_(visited_accounts)).all()
    for a in accounts:
        nodes.append({"id": a.account_id, "type": "account", "risk_level": a.risk_level or "low"})

    if visited_devices:
        devices = db.query(Device).filter(Device.device_id.in_(visited_devices)).all()
        for d in devices:
            nodes.append({"id": d.device_id, "type": "device", "risk_level": d.risk_level or "low"})

    # Safety net: a graph UI breaks on an edge pointing at a node that was never returned
    # (e.g. a transaction referencing a device id that has no Device row).
    node_ids = {n["id"] for n in nodes}
    edges = [e for e in edges if e["source"] in node_ids and e["target"] in node_ids]

    return nodes, edges
