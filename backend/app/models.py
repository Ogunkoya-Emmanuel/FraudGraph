from sqlalchemy import Column, String, Float, DateTime, Boolean, JSON, ForeignKey, Integer
from sqlalchemy.orm import relationship

from app.database import Base


class Account(Base):
    __tablename__ = "accounts"

    account_id = Column(String, primary_key=True)
    owner_name = Column(String, nullable=False)
    phone = Column(String)
    id_number = Column(String)
    city = Column(String, index=True)
    account_type = Column(String)
    opened_date = Column(String)

    risk_score = Column(Float, default=0.0, index=True)
    risk_level = Column(String, default="low", index=True)  # low | medium | high | critical
    flagged_patterns = Column(JSON, default=list)  # list[str]
    ml_score = Column(Float, default=0.0)
    anomaly_score = Column(Float, default=0.0)

    sent_transactions = relationship(
        "Transaction", foreign_keys="Transaction.sender_account", back_populates="sender"
    )
    received_transactions = relationship(
        "Transaction", foreign_keys="Transaction.receiver_account", back_populates="receiver"
    )


class Device(Base):
    __tablename__ = "devices"

    device_id = Column(String, primary_key=True)
    device_type = Column(String)

    risk_level = Column(String, default="low")
    flagged = Column(Boolean, default=False)
    linked_account_count = Column(Integer, default=0)


class Transaction(Base):
    __tablename__ = "transactions"

    txn_id = Column(String, primary_key=True)
    sender_account = Column(String, ForeignKey("accounts.account_id"), nullable=False, index=True)
    receiver_account = Column(String, ForeignKey("accounts.account_id"), nullable=False, index=True)
    amount = Column(Float, nullable=False)
    timestamp = Column(DateTime, nullable=False, index=True)
    channel = Column(String)
    device_id = Column(String, ForeignKey("devices.device_id"), nullable=True, index=True)
    ip_address = Column(String, index=True)
    location = Column(String)
    status = Column(String, default="successful", index=True)

    flagged = Column(Boolean, default=False)
    flagged_reason = Column(String, nullable=True)

    sender = relationship("Account", foreign_keys=[sender_account], back_populates="sent_transactions")
    receiver = relationship("Account", foreign_keys=[receiver_account], back_populates="received_transactions")


class Alert(Base):
    __tablename__ = "alerts"

    alert_id = Column(String, primary_key=True)
    entity_id = Column(String, nullable=False, index=True)
    entity_type = Column(String, nullable=False)  # account | device
    pattern = Column(String, nullable=False, index=True)
    severity = Column(String, nullable=False, index=True)  # low | medium | high | critical
    # When the pattern was completed - the timestamp of the triggering transaction,
    # not the time the seed script ran.
    detected_at = Column(DateTime, nullable=False, index=True)
    status = Column(String, default="new", index=True)  # new | investigating | confirmed | false_positive | closed
    feedback = Column(String, nullable=True)  # genuine_fraud | suspicious | false_positive | under_investigation
    updated_at = Column(DateTime, nullable=True)  # last time an analyst changed status/feedback

    explanation = Column(JSON, default=list)       # list[str], rule-based (always present)
    explanation_source = Column(String, default="rule_based")  # rule_based | gemini
    related_transactions = Column(JSON, default=list)
    connected_entities = Column(JSON, default=list)


class Case(Base):
    __tablename__ = "cases"

    case_id = Column(String, primary_key=True)
    alert_id = Column(String, ForeignKey("alerts.alert_id"), nullable=False, index=True)
    status = Column(String, default="new", index=True)
    notes = Column(String, default="")
    related_entities = Column(JSON, default=list)
    created_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, nullable=False)
