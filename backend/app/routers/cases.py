from datetime import datetime, timezone
from typing import Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Case, Alert
from app.schemas import (
    CaseCreateRequest, CaseListResponse, CaseListItem, CaseDetail, CaseUpdateRequest,
)

router = APIRouter(prefix="/cases", tags=["cases"])

OPEN_CASE_STATUSES = ("new", "investigating")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _new_case_id() -> str:
    # Random, not count()+1: counting collides after a delete or when two requests race.
    return f"FG-{uuid.uuid4().hex[:8].upper()}"


def _detail(c: Case) -> CaseDetail:
    return CaseDetail(
        case_id=c.case_id, alert_id=c.alert_id, status=c.status, notes=c.notes or "",
        related_entities=c.related_entities or [], created_at=c.created_at, updated_at=c.updated_at,
    )


@router.post("", response_model=CaseDetail, status_code=201)
def create_case(body: CaseCreateRequest, db: Session = Depends(get_db)):
    alert = db.get(Alert, body.alert_id)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")

    existing = (
        db.query(Case)
        .filter(Case.alert_id == body.alert_id, Case.status.in_(OPEN_CASE_STATUSES))
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Alert {body.alert_id} already has an open case ({existing.case_id})",
        )

    now = _now()
    related = [alert.entity_id] + [e for e in (alert.connected_entities or []) if e != alert.entity_id]

    # Opening a case means someone is now investigating this alert.
    if alert.status == "new":
        alert.status = "investigating"
        alert.updated_at = now

    for attempt in range(3):  # a random-ID collision is astronomically unlikely, but cheap to survive
        case = Case(
            case_id=_new_case_id(), alert_id=body.alert_id, status="new",
            notes=body.notes, related_entities=related, created_at=now, updated_at=now,
        )
        db.add(case)
        try:
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 2:
                raise HTTPException(status_code=500, detail="Could not allocate a case id, please retry")
            # the rollback expired the alert; re-apply the status change on the next attempt
            alert = db.get(Alert, body.alert_id)
            if alert and alert.status == "new":
                alert.status = "investigating"
                alert.updated_at = now
    return _detail(case)


@router.get("", response_model=CaseListResponse)
def list_cases(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(Case)
    if status:
        q = q.filter(Case.status == status)
    rows = q.order_by(Case.created_at.desc(), Case.case_id.desc()).all()
    return CaseListResponse(cases=[
        CaseListItem(case_id=c.case_id, alert_id=c.alert_id, status=c.status, created_at=c.created_at)
        for c in rows
    ])


@router.get("/{case_id}", response_model=CaseDetail)
def get_case(case_id: str, db: Session = Depends(get_db)):
    c = db.get(Case, case_id)
    if not c:
        raise HTTPException(status_code=404, detail="Case not found")
    return _detail(c)


@router.patch("/{case_id}", response_model=CaseDetail)
def update_case(case_id: str, body: CaseUpdateRequest, db: Session = Depends(get_db)):
    c = db.get(Case, case_id)
    if not c:
        raise HTTPException(status_code=404, detail="Case not found")
    now = _now()
    if body.status is not None:
        c.status = body.status
        # keep the alert in step with its case, so dashboard "active alerts" reflects reality
        alert = db.get(Alert, c.alert_id)
        if alert:
            alert.status = body.status
            alert.updated_at = now
    if body.notes is not None:
        c.notes = body.notes
    c.updated_at = now
    db.commit()
    return _detail(c)
