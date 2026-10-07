from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.routers import dashboard, accounts, transactions, alerts, cases
from app.security import require_api_key


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Idempotent: creates any missing tables, never drops or alters existing ones.
    # (python -m app.seed is what fills them with data.)
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(
    title="FraudGraph API",
    description="Graph-based fraud detection and investigation platform for Ecobank InnovateX 2026.",
    version="1.1.0",
    lifespan=lifespan,
)

# Only the configured frontend origins may call the API from a browser.
# No wildcard, and no credentials/cookies are used (auth, if enabled, is the X-API-Key header).
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)

_protected = [Depends(require_api_key)]
app.include_router(dashboard.router, prefix="/api/v1", dependencies=_protected)
app.include_router(accounts.router, prefix="/api/v1", dependencies=_protected)
app.include_router(transactions.router, prefix="/api/v1", dependencies=_protected)
app.include_router(alerts.router, prefix="/api/v1", dependencies=_protected)
app.include_router(cases.router, prefix="/api/v1", dependencies=_protected)


@app.get("/")
def root():
    return {"service": "FraudGraph API", "status": "ok", "docs": "/docs"}


@app.get("/health")
def health():
    """Liveness + database connectivity (no auth, so load balancers can call it)."""
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
        return {"status": "ok", "database": "ok"}
    except Exception:  # noqa: BLE001
        return {"status": "degraded", "database": "unreachable"}
