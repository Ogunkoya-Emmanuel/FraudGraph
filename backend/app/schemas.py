from datetime import datetime
from typing import Optional, List, Literal

from pydantic import BaseModel

RiskLevel = Literal["low", "medium", "high", "critical"]
AlertStatus = Literal["new", "investigating", "confirmed", "false_positive", "closed"]
AlertFeedback = Literal["genuine_fraud", "suspicious", "false_positive", "under_investigation"]
TxnStatus = Literal["successful", "failed", "pending", "reversed"]


# ---------- Dashboard ----------

class RecentAlert(BaseModel):
    alert_id: str
    entity_id: str
    severity: RiskLevel
    detected_at: datetime
    pattern: str


class DashboardSummary(BaseModel):
    total_transactions: int
    total_accounts: int
    active_alerts: int
    risk_distribution: dict
    high_risk_account_count: int
    recent_alerts: List[RecentAlert]


# ---------- Accounts ----------

class AccountListItem(BaseModel):
    account_id: str
    owner_name: str
    city: Optional[str]
    account_type: Optional[str]
    risk_score: float
    risk_level: RiskLevel
    flagged_patterns: List[str]
    ml_score: Optional[float] = 0.0
    anomaly_score: Optional[float] = 0.0


class AccountListResponse(BaseModel):
    total_results: int
    page: int
    page_size: int
    accounts: List[AccountListItem]


class RecentTxnSummary(BaseModel):
    txn_id: str
    direction: Literal["in", "out"]
    counterparty: str
    amount: float
    timestamp: datetime


class AccountDetail(BaseModel):
    account_id: str
    owner_name: str
    phone: Optional[str]
    city: Optional[str]
    account_type: Optional[str]
    opened_date: Optional[str]
    risk_score: float
    risk_level: RiskLevel
    explanation: List[str]
    flagged_patterns: List[str]
    connected_devices: List[str]
    connected_accounts: List[str]
    recent_transactions: List[RecentTxnSummary]
    ml_score: Optional[float] = 0.0
    anomaly_score: Optional[float] = 0.0


class NetworkNode(BaseModel):
    id: str
    type: Literal["account", "device"]
    risk_level: RiskLevel


class NetworkEdge(BaseModel):
    source: str
    target: str
    type: Literal["transaction", "device_link"]
    weight: Optional[float] = None
    txn_count: Optional[int] = None


class AccountNetwork(BaseModel):
    center_account: str
    nodes: List[NetworkNode]
    edges: List[NetworkEdge]


# ---------- Transactions ----------

class TransactionListItem(BaseModel):
    txn_id: str
    sender_account: str
    receiver_account: str
    amount: float
    timestamp: datetime
    channel: Optional[str]
    device_id: Optional[str]
    status: TxnStatus


class TransactionListResponse(BaseModel):
    total_results: int
    page: int
    page_size: int
    transactions: List[TransactionListItem]


class TransactionDetail(BaseModel):
    txn_id: str
    sender_account: str
    receiver_account: str
    amount: float
    timestamp: datetime
    channel: Optional[str]
    device_id: Optional[str]
    ip_address: Optional[str]
    location: Optional[str]
    status: TxnStatus
    flagged: bool
    flagged_reason: Optional[str]


# ---------- Alerts ----------

class AlertListItem(BaseModel):
    alert_id: str
    entity_id: str
    entity_type: Literal["account", "device"]
    pattern: str
    severity: RiskLevel
    detected_at: datetime
    status: AlertStatus
    related_transaction_count: int


class AlertListResponse(BaseModel):
    total_results: int
    alerts: List[AlertListItem]


class AlertDetail(BaseModel):
    alert_id: str
    entity_id: str
    entity_type: Literal["account", "device"]
    pattern: str
    severity: RiskLevel
    detected_at: datetime
    status: AlertStatus
    feedback: Optional[AlertFeedback] = None
    updated_at: Optional[datetime] = None
    explanation: List[str]
    explanation_source: Literal["rule_based", "gemini"]
    related_transactions: List[str]
    connected_entities: List[str]


class AlertFeedbackRequest(BaseModel):
    feedback: AlertFeedback


class AlertFeedbackResponse(BaseModel):
    alert_id: str
    feedback: AlertFeedback
    status: AlertStatus      # the alert's status after the feedback was applied
    updated_at: datetime


# ---------- Cases ----------

class CaseCreateRequest(BaseModel):
    alert_id: str
    notes: str = ""


class CaseListItem(BaseModel):
    case_id: str
    alert_id: str
    status: AlertStatus
    created_at: datetime


class CaseListResponse(BaseModel):
    cases: List[CaseListItem]


class CaseDetail(BaseModel):
    case_id: str
    alert_id: str
    status: AlertStatus
    notes: str
    related_entities: List[str]
    created_at: datetime
    updated_at: datetime


class CaseUpdateRequest(BaseModel):
    status: Optional[AlertStatus] = None
    notes: Optional[str] = None
