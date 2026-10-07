from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Alert
from app.schemas import (
    AlertListResponse, AlertListItem, AlertDetail,
    AlertFeedbackRequest, AlertFeedbackResponse,
)

router = APIRouter(prefix="/alerts", tags=["alerts"])

# Analyst feedback moves the alert through its lifecycle, so the dashboard's
# "active alerts" count goes down when alerts are resolved.
FEEDBACK_TO_STATUS = {
    "genuine_fraud": "confirmed",
    "false_positive": "false_positive",
    "suspicious": "investigating",
    "under_investigation": "investigating",
}


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@router.get("", response_model=AlertListResponse)
def list_alerts(
    severity: Optional[str] = None,
    status: Optional[str] = None,
    pattern: Optional[str] = None,
    entity_id: Optional[str] = None,
    limit: Optional[int] = Query(None, ge=1, le=1000, description="Max alerts to return (default: all)"),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    q = db.query(Alert)
    if severity:
        q = q.filter(Alert.severity == severity)
    if status:
        q = q.filter(Alert.status == status)
    if pattern:
        q = q.filter(Alert.pattern.ilike(f"%{pattern}%"))
    if entity_id:
        q = q.filter(Alert.entity_id == entity_id)

    total = q.count()
    q = q.order_by(Alert.detected_at.desc(), Alert.alert_id.desc())  # alert_id breaks ties deterministically
    if offset:
        q = q.offset(offset)
    if limit:
        q = q.limit(limit)
    rows = q.all()

    return AlertListResponse(
        total_results=total,
        alerts=[
            AlertListItem(
                alert_id=a.alert_id, entity_id=a.entity_id, entity_type=a.entity_type,
                pattern=a.pattern, severity=a.severity, detected_at=a.detected_at,
                status=a.status, related_transaction_count=len(a.related_transactions or []),
            ) for a in rows
        ],
    )


@router.get("/{alert_id}", response_model=AlertDetail)
def get_alert(alert_id: str, db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(status_code=404, detail="Alert not found")
    return AlertDetail(
        alert_id=a.alert_id, entity_id=a.entity_id, entity_type=a.entity_type,
        pattern=a.pattern, severity=a.severity, detected_at=a.detected_at, status=a.status,
        feedback=a.feedback, updated_at=a.updated_at,
        explanation=a.explanation or [], explanation_source=a.explanation_source,
        related_transactions=a.related_transactions or [], connected_entities=a.connected_entities or [],
    )


@router.patch("/{alert_id}/feedback", response_model=AlertFeedbackResponse)
def set_alert_feedback(alert_id: str, body: AlertFeedbackRequest, db: Session = Depends(get_db)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(status_code=404, detail="Alert not found")
    now = _now()
    a.feedback = body.feedback
    a.status = FEEDBACK_TO_STATUS[body.feedback]
    a.updated_at = now  # persisted, so what we return is what is stored
    db.commit()
    return AlertFeedbackResponse(
        alert_id=alert_id, feedback=body.feedback, status=a.status, updated_at=now,
    )
