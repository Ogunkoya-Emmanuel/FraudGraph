from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Transaction, Account, Alert
from app.schemas import DashboardSummary, RecentAlert

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
def get_summary(db: Session = Depends(get_db)):
    total_transactions = db.query(func.count(Transaction.txn_id)).scalar() or 0
    total_accounts = db.query(func.count(Account.account_id)).scalar() or 0
    active_alerts = (
        db.query(func.count(Alert.alert_id))
        .filter(Alert.status.in_(["new", "investigating"]))
        .scalar() or 0
    )

    risk_rows = (
        db.query(Account.risk_level, func.count(Account.account_id))
        .group_by(Account.risk_level)
        .all()
    )
    risk_distribution = {"low": 0, "medium": 0, "high": 0, "critical": 0}
    for level, count in risk_rows:
        if level in risk_distribution:
            risk_distribution[level] = count

    high_risk_account_count = risk_distribution["high"] + risk_distribution["critical"]

    # most recent first, by when the fraud pattern completed (triggering transaction time)
    recent = (
        db.query(Alert)
        .order_by(Alert.detected_at.desc(), Alert.alert_id.desc())
        .limit(10)
        .all()
    )

    return DashboardSummary(
        total_transactions=total_transactions,
        total_accounts=total_accounts,
        active_alerts=active_alerts,
        risk_distribution=risk_distribution,
        high_risk_account_count=high_risk_account_count,
        recent_alerts=[
            RecentAlert(
                alert_id=a.alert_id, entity_id=a.entity_id,
                severity=a.severity, detected_at=a.detected_at, pattern=a.pattern,
            ) for a in recent
        ],
    )
