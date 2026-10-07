"""
Central app configuration.

Reads from a .env file (see .env.example) using pydantic-settings, so every
other module imports `settings` from here instead of touching os.environ
directly. This is the ONE place that knows where the database URL and the
Gemini key live.
"""

from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database - PostgreSQL by default (see docker-compose.yml for a one-command local instance).
    # SQLite still works for quick local tests: DATABASE_URL=sqlite:///./fraudgraph.db
    database_url: str = "postgresql+psycopg2://fraudgraph:fraudgraph@localhost:5432/fraudgraph"

    # API security. If API_KEY is set, every /api/v1 request must send it in the
    # X-API-Key header. Left blank, auth is disabled (fine for local dev only).
    api_key: str = ""
    # Comma-separated list of allowed browser origins (your frontend). No wildcard.
    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    # Gemini (optional - app must work with this blank)
    gemini_api_key: str = ""
    # gemini-2.0-flash was shut down by Google on 1 June 2026. Model IDs retire quickly,
    # so this is configurable; the fallback model is tried if the primary returns 404.
    gemini_model: str = "gemini-3.5-flash"
    gemini_fallback_model: str = "gemini-3.1-flash-lite"
    gemini_timeout_seconds: float = 8.0

    # Risk thresholds (band cutoffs, 0-100 scale)
    risk_band_medium: int = 31
    risk_band_high: int = 61
    risk_band_critical: int = 81

    # Detection thresholds - tuned for the synthetic dataset's scale.
    # Adjust if you regenerate data at a different size.
    fanin_min_senders: int = 6           # distinct senders into one account in the window
    fanin_window_hours: int = 6
    shared_device_min_accounts: int = 4  # distinct accounts on one device = suspicious
    passthrough_window_minutes: int = 45
    passthrough_min_ratio: float = 0.80  # fraction of inbound amount sent back out
    passthrough_min_amount: float = 50_000.0  # ignore small transfers (materiality floor)
    cycle_max_length: int = 6
    cycle_window_hours: int = 24
    cycle_min_amount: float = 50_000.0   # only chase cycles among meaningful-value transfers

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
