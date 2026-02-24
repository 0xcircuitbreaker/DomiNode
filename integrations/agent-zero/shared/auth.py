"""DomiNode authentication helper for Agent Zero tools.

Provides JWT-based authentication using the ``/api/auth/verify-key`` flow,
automatic 401 retry, credential sanitisation, and prototype-pollution-safe
JSON parsing.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional
from urllib.parse import quote

import httpx

from .constants import CREDENTIAL_RE, DANGEROUS_KEYS, MAX_RESPONSE_BYTES

# ---------------------------------------------------------------------------
# User-Agent header sent on every request
# ---------------------------------------------------------------------------

_USER_AGENT = "dominusnode-agent-zero/1.0.0"


class DominusNodeAuth:
    """JWT auth helper with verify-key flow and transparent 401 retry.

    Usage::

        auth = DominusNodeAuth(
            api_key="dn_live_...",
            base_url="https://api.dominusnode.com",
        )
        data = auth.api_request("GET", "/api/wallet")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.api_key: str = api_key or os.environ.get("DOMINUSNODE_API_KEY", "")
        if not self.api_key:
            raise ValueError(
                "DomiNode API key is required.  "
                "Pass api_key= or set DOMINUSNODE_API_KEY."
            )

        self.base_url: str = (
            base_url
            or os.environ.get("DOMINUSNODE_BASE_URL", "https://api.dominusnode.com")
        )
        self.timeout: float = timeout
        self._token: Optional[str] = None

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def _authenticate(self) -> str:
        """Exchange the API key for a JWT via ``/api/auth/verify-key``."""
        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            resp = client.post(
                f"{self.base_url}/api/auth/verify-key",
                json={"apiKey": self.api_key},
                headers={
                    "User-Agent": _USER_AGENT,
                    "Content-Type": "application/json",
                },
            )

            if resp.status_code != 200:
                body = self.sanitize_error(resp.text[:500])
                raise RuntimeError(
                    f"Authentication failed ({resp.status_code}): {body}"
                )

            data = resp.json()
            token = data.get("token")
            if not token:
                raise RuntimeError("Authentication response missing token")
            self._token = token
            return token

    def ensure_auth(self) -> None:
        """Ensure a valid JWT token exists, authenticating if needed."""
        if self._token is None:
            self._authenticate()

    # ------------------------------------------------------------------
    # Authenticated API requests
    # ------------------------------------------------------------------

    def api_request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        *,
        _retry: bool = True,
    ) -> Any:
        """Make an authenticated API request to the DomiNode REST API.

        Automatically retries once on 401 (token expired) by
        re-authenticating and replaying the request.

        Args:
            method: HTTP method (GET, POST, PATCH, DELETE).
            path: API path (e.g. ``/api/wallet``).
            body: Optional JSON body for POST/PATCH/DELETE requests.

        Returns:
            Parsed JSON response (with dangerous keys stripped).

        Raises:
            RuntimeError: On authentication failure or API errors.
        """
        self.ensure_auth()

        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=False,
        ) as client:
            kwargs: Dict[str, Any] = {
                "headers": {
                    "User-Agent": _USER_AGENT,
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._token}",
                },
            }

            if body is not None and method.upper() not in ("GET", "HEAD", "OPTIONS"):
                kwargs["json"] = body

            resp = client.request(method, f"{self.base_url}{path}", **kwargs)

            if len(resp.content) > MAX_RESPONSE_BYTES:
                raise RuntimeError("Response body too large")

            # Transparent 401 retry
            if resp.status_code == 401 and _retry:
                self._token = None
                self._authenticate()
                return self.api_request(method, path, body, _retry=False)

            if resp.status_code >= 400:
                try:
                    err_data = resp.json()
                    msg = err_data.get("error", resp.text)
                except Exception:
                    msg = resp.text
                msg = str(msg)[:500]
                raise RuntimeError(
                    f"API error {resp.status_code}: {self.sanitize_error(msg)}"
                )

            if resp.text:
                data = self.safe_json_parse(resp.text)
                return data
            return {}

    # ------------------------------------------------------------------
    # Security utilities
    # ------------------------------------------------------------------

    def sanitize_error(self, message: str) -> str:
        """Remove DomiNode API key patterns from error messages."""
        return CREDENTIAL_RE.sub("***", message)

    def strip_dangerous_keys(self, obj: Any, depth: int = 0) -> None:
        """Recursively remove prototype pollution keys from parsed JSON."""
        if depth > 50 or obj is None or not isinstance(obj, (dict, list)):
            return
        if isinstance(obj, list):
            for item in obj:
                self.strip_dangerous_keys(item, depth + 1)
            return
        keys_to_remove = [k for k in obj if k in DANGEROUS_KEYS]
        for k in keys_to_remove:
            del obj[k]
        for v in obj.values():
            if isinstance(v, (dict, list)):
                self.strip_dangerous_keys(v, depth + 1)

    def safe_json_parse(self, text: str) -> Any:
        """Parse JSON and strip prototype pollution keys."""
        data = json.loads(text)
        self.strip_dangerous_keys(data)
        return data

    # ------------------------------------------------------------------
    # Helpers for URL path encoding
    # ------------------------------------------------------------------

    @staticmethod
    def url_encode(value: str) -> str:
        """URL-encode a path segment (safe='')."""
        return quote(value, safe="")
