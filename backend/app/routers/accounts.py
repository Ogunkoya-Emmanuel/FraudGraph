from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.explain import LARGE_AMOUNT_SENTENCE
from app.graph_utils import build_account_network
from app.models import Account, Alert, Transaction
from app.schemas import (
    AccountListResponse, AccountListItem, AccountDetail, RecentTxnSummary,
    AccountNetwork, NetworkNode, NetworkEdge,
)

router = APIRouter(prefix="/accounts", tags=["accounts"])


def _like_pattern(term: str) -> str:
    """Escape LIKE wildcards so searching for '%' or '_' matches literally."""
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("", response_model=AccountListResponse)
def list_accounts(
    search: Optional[str] = None,
    risk_level: Optional[str] = None,
    city: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Account)
    if search:
        like = _like_pattern(search)
        q = q.filter(or_(
            Account.account_id.ilike(like, escape="\\"),
            Account.owner_name.ilike(like, escape="\\"),
            Account.phone.ilike(like, escape="\\"),
        ))
    if risk_level:
        q = q.filter(Account.risk_level == risk_level)
    if city:
        q = q.filter(Account.city == city)

    total = q.count()
    rows = (
        # account_id breaks score ties, so pages never overlap or skip rows
        q.order_by(Account.risk_score.desc(), Account.account_id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return AccountListResponse(
        total_results=total, page=page, page_size=page_size,
        accounts=[
            AccountListItem(
                account_id=a.account_id, owner_name=a.owner_name, city=a.city,
                account_type=a.account_type, risk_score=a.risk_score,
                risk_level=a.risk_level, flagged_patterns=a.flagged_patterns or [],
                ml_score=round(a.ml_score, 1) if a.ml_score is not None else 0.0,
                anomaly_score=round(a.anomaly_score, 1) if a.anomaly_score is not None else 0.0,
            ) for a in rows
        ],
    )


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(account_id: str, db: Session = Depends(get_db)):
    acc = db.get(Account, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    # Merge the explanations of ALL this account's alerts (one per pattern), newest first,
    # instead of showing whichever single alert the database happened to return first.
    alerts = (
        db.query(Alert)
        .filter(Alert.entity_id == account_id, Alert.entity_type == "account")
        .order_by(Alert.detected_at.desc(), Alert.alert_id.desc())
        .all()
    )
    explanation = []
    for alert in alerts:
        for sentence in alert.explanation or []:
            if sentence not in explanation:
                explanation.append(sentence)
    if "large_amount_anomaly" in (acc.flagged_patterns or []) and LARGE_AMOUNT_SENTENCE not in explanation:
        explanation.append(LARGE_AMOUNT_SENTENCE)

    sent = (
        db.query(Transaction)
        .filter(Transaction.sender_account == account_id)
        .order_by(Transaction.timestamp.desc(), Transaction.txn_id)
        .limit(10)
        .all()
    )
    received = (
        db.query(Transaction)
        .filter(Transaction.receiver_account == account_id)
        .order_by(Transaction.timestamp.desc(), Transaction.txn_id)
        .limit(10)
        .all()
    )
    recent = sorted(
        [RecentTxnSummary(txn_id=t.txn_id, direction="out", counterparty=t.receiver_account,
                           amount=t.amount, timestamp=t.timestamp) for t in sent]
        + [RecentTxnSummary(txn_id=t.txn_id, direction="in", counterparty=t.sender_account,
                             amount=t.amount, timestamp=t.timestamp) for t in received],
        key=lambda r: r.timestamp, reverse=True,
    )[:10]

    connected_devices = sorted({t.device_id for t in sent if t.device_id})
    connected_accounts = sorted({t.receiver_account for t in sent} | {t.sender_account for t in received})

    return AccountDetail(
        account_id=acc.account_id, owner_name=acc.owner_name, phone=acc.phone,
        city=acc.city, account_type=acc.account_type, opened_date=acc.opened_date,
        risk_score=acc.risk_score, risk_level=acc.risk_level,
        explanation=explanation, flagged_patterns=acc.flagged_patterns or [],
        connected_devices=connected_devices, connected_accounts=connected_accounts,
        recent_transactions=recent,
        ml_score=round(acc.ml_score, 1) if acc.ml_score is not None else 0.0,
        anomaly_score=round(acc.anomaly_score, 1) if acc.anomaly_score is not None else 0.0,
    )


@router.get("/{account_id}/network", response_model=AccountNetwork)
def get_account_network(
    account_id: str,
    depth: int = Query(1, ge=1, le=3),
    db: Session = Depends(get_db),
):
    if not db.get(Account, account_id):
        raise HTTPException(status_code=404, detail="Account not found")

    nodes, edges = build_account_network(db, account_id, depth)
    return AccountNetwork(
        center_account=account_id,
        nodes=[NetworkNode(**n) for n in nodes],
        edges=[NetworkEdge(**e) for e in edges],
    )
