"""
API smoke tests against a throwaway SQLite database (see conftest.py) - no PostgreSQL needed.

NOTE: these need the real fastapi / sqlalchemy / httpx packages (pip install -r requirements.txt)
and are skipped if they are missing. They were written without being able to run them in the
authoring sandbox, so treat the first `pytest` run on your machine as the real verification.
"""
import pytest

pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture(scope="module")
def client():
    from app import seed
    from app.main import app
    seed.main()
    with TestClient(app) as c:
        yield c


def test_health_reports_database_ok(client):
    assert client.get("/health").json() == {"status": "ok", "database": "ok"}


def test_dashboard_and_recent_alerts_are_ordered_by_real_time(client):
    s = client.get("/api/v1/dashboard/summary").json()
    assert s["total_accounts"] > 0 and s["active_alerts"] > 0
    stamps = [a["detected_at"] for a in s["recent_alerts"]]
    assert stamps == sorted(stamps, reverse=True) and len(set(stamps)) > 1


def test_alert_feedback_changes_status_and_active_count(client):
    before = client.get("/api/v1/dashboard/summary").json()["active_alerts"]
    alert_id = client.get("/api/v1/alerts", params={"status": "new", "limit": 1}).json()["alerts"][0]["alert_id"]
    r = client.patch(f"/api/v1/alerts/{alert_id}/feedback", json={"feedback": "false_positive"}).json()
    assert r["status"] == "false_positive"
    detail = client.get(f"/api/v1/alerts/{alert_id}").json()
    assert detail["status"] == "false_positive" and detail["updated_at"] == r["updated_at"]
    assert client.get("/api/v1/dashboard/summary").json()["active_alerts"] == before - 1


def test_case_lifecycle_syncs_back_to_alert(client):
    alert_id = client.get("/api/v1/alerts", params={"status": "new", "limit": 1}).json()["alerts"][0]["alert_id"]
    created = client.post("/api/v1/cases", json={"alert_id": alert_id, "notes": "look into it"})
    assert created.status_code == 201
    case_id = created.json()["case_id"]
    assert client.get(f"/api/v1/alerts/{alert_id}").json()["status"] == "investigating"
    assert client.post("/api/v1/cases", json={"alert_id": alert_id}).status_code == 409
    client.patch(f"/api/v1/cases/{case_id}", json={"status": "closed"})
    assert client.get(f"/api/v1/alerts/{alert_id}").json()["status"] == "closed"


def test_account_detail_merges_all_alert_explanations(client):
    top = client.get("/api/v1/accounts", params={"page_size": 5}).json()["accounts"]
    assert [a["risk_score"] for a in top] == sorted((a["risk_score"] for a in top), reverse=True)
    detail = client.get(f"/api/v1/accounts/{top[0]['account_id']}").json()
    n_alerts = client.get("/api/v1/alerts", params={"entity_id": top[0]["account_id"]}).json()["total_results"]
    assert n_alerts >= 1 and len(detail["explanation"]) >= n_alerts - 1


def test_network_has_no_dangling_edges(client):
    acc = client.get("/api/v1/accounts", params={"page_size": 1}).json()["accounts"][0]["account_id"]
    g = client.get(f"/api/v1/accounts/{acc}/network", params={"depth": 2}).json()
    ids = {n["id"] for n in g["nodes"]}
    assert g["edges"] and all(e["source"] in ids and e["target"] in ids for e in g["edges"])


def test_transactions_accept_timezone_aware_filters_and_flagged_filter(client):
    r = client.get("/api/v1/transactions", params={"date_from": "2026-08-01T00:00:00Z", "flagged": "true"})
    assert r.status_code == 200 and r.json()["total_results"] > 0


def test_cors_is_not_a_wildcard(client):
    allowed = client.get("/health", headers={"Origin": "http://localhost:3000"})
    other = client.get("/health", headers={"Origin": "http://evil.example"})
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert "access-control-allow-origin" not in other.headers


def test_api_key_is_enforced_when_configured(client, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "api_key", "s3cret")
    assert client.get("/api/v1/dashboard/summary").status_code == 401
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": "wrong"}).status_code == 401
    assert client.get("/api/v1/dashboard/summary", headers={"X-API-Key": "s3cret"}).status_code == 200
    assert client.get("/health").status_code == 200   # health stays open for load balancers
