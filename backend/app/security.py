"""
Optional API-key authentication.

If API_KEY is set in .env, every /api/v1 request must carry it in the
`X-API-Key` header (the interactive docs at /docs have an "Authorize" button
for it). If API_KEY is blank, auth is disabled - fine for local development,
NOT for anything exposed to a network.

This is a deliberately small mechanism for the hackathon. For a bank
deployment you would put the API behind the bank's identity provider
(OAuth2/OIDC, per-analyst roles, audit log of who changed which alert) -
see the "Security" section of the README.
"""

import secrets
from typing import Optional

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from app.config import settings

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_api_key(provided: Optional[str] = Security(_api_key_header)) -> None:
    expected = settings.api_key
    if not expected:
        return  # auth disabled
    if not provided or not secrets.compare_digest(provided.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Missing or invalid API key")
