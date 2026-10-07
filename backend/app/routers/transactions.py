from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Transaction
from app.schemas import TransactionListResponse, TransactionListItem, TransactionDetail

router = APIRouter(prefix="/transactions", tags=["transactions"])


def _naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Timestamps are stored as naive UTC. A timezone-aware filter value (e.g. '...Z') compared
    against a naive column is silently shifted by the database session timezone on PostgreSQL,
    so normalise it first."""
    if dt is not None and dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


@router.get("", response_model=TransactionListResponse)
def list_transactions(
    account_id: Optional[str] = None,
    device_id: Optional[str] = None,
    ip_address: Optional[str] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    status: Optional[str] = None,
    flagged: Optional[bool] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    db: Session = Depends(get_db),
):
    date_from, date_to = _naive_utc(date_from), _naive_utc(date_to)

    q = db.query(Transaction)
    if account_id:
        q = q.filter(
            (Transaction.sender_account == account_id) | (Transaction.receiver_account == account_id)
        )
    if device_id:
        q = q.filter(Transaction.device_id == device_id)
    if ip_address:
        q = q.filter(Transaction.ip_address == ip_address)
    if min_amount is not None:
        q = q.filter(Transaction.amount >= min_amount)
    if max_amount is not None:
        q = q.filter(Transaction.amount <= max_amount)
    if date_from:
        q = q.filter(Transaction.timestamp >= date_from)
    if date_to:
        q = q.filter(Transaction.timestamp <= date_to)
    if status:
        q = q.filter(Transaction.status == status)
    if flagged is not None:
        q = q.filter(Transaction.flagged == flagged)

    total = q.count()
    rows = (
        q.order_by(Transaction.timestamp.desc(), Transaction.txn_id)  # txn_id keeps paging stable
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return TransactionListResponse(
        total_results=total, page=page, page_size=page_size,
        transactions=[
            TransactionListItem(
                txn_id=t.txn_id, sender_account=t.sender_account, receiver_account=t.receiver_account,
                amount=t.amount, timestamp=t.timestamp, channel=t.channel,
                device_id=t.device_id, status=t.status,
            ) for t in rows
        ],
    )


@router.get("/{txn_id}", response_model=TransactionDetail)
def get_transaction(txn_id: str, db: Session = Depends(get_db)):
    t = db.get(Transaction, txn_id)
    if not t:
        raise HTTPException(status_code=404, detail="Transaction not found")
    return TransactionDetail(
        txn_id=t.txn_id, sender_account=t.sender_account, receiver_account=t.receiver_account,
        amount=t.amount, timestamp=t.timestamp, channel=t.channel, device_id=t.device_id,
        ip_address=t.ip_address, location=t.location, status=t.status,
        flagged=bool(t.flagged), flagged_reason=t.flagged_reason,
    )
