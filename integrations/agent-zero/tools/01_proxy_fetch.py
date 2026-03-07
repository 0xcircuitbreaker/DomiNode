"""Agent Zero tools: proxied HTTP fetch, proxy config, active sessions, proxy status.

Tools:
    - ``proxied_fetch`` -- Fetch a URL through the Dominus Node proxy gateway
    - ``get_proxy_config`` -- Retrieve proxy endpoint configuration
    - ``list_sessions`` -- List active proxy sessions
    - ``get_proxy_status`` -- Get proxy gateway health and pool status

Security:
    - SSRF validation on all URLs (private IPs, hex/octal, DNS rebinding)
    - OFAC sanctioned country blocking
    - Read-only HTTP methods only (GET, HEAD, OPTIONS)
    - Credential scrubbing in all error messages
    - Response body truncation (4000 chars for AI context)
    - No redirect following (prevents open redirect abuse)
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict

import httpx

from shared import (
    ALLOWED_METHODS,
    MAX_BODY_TRUNCATE,
    MAX_RESPONSE_BYTES,
    SANCTIONED_COUNTRIES,
    DominusNodeAuth,
    validate_url,
)
from shared.constants import CREDENTIAL_RE

# ---------------------------------------------------------------------------
# Helper: sanitise error messages
# ---------------------------------------------------------------------------


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Blocked headers (must not be forwarded through proxy)
# ---------------------------------------------------------------------------

_BLOCKED_HEADERS = frozenset({
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "proxy-authorization",
    "authorization",
    "user-agent",
})


# ---------------------------------------------------------------------------
# Tool: proxied_fetch
# ---------------------------------------------------------------------------


def proxied_fetch(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Fetch a URL through the Dominus Node rotating proxy gateway.

    Routes HTTP requests through the proxy gateway using CONNECT tunnelling
    for HTTPS and full-URL path rewriting for plain HTTP.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``url`` (str, required): Target URL to fetch.
            - ``method`` (str, optional): HTTP method (GET/HEAD/OPTIONS). Default: GET.
            - ``country`` (str, optional): Two-letter country code for geo-targeting.
            - ``proxy_type`` (str, optional): ``dc`` or ``residential``. Default: dc.
            - ``headers`` (dict, optional): Custom headers to forward.

    Returns:
        JSON string with ``status``, ``headers``, and ``body`` keys,
        or an ``error`` key on failure.
    """
    # --- Validate URL ---
    url = args.get("url")
    if not url or not isinstance(url, str):
        return json.dumps({"error": "url is required and must be a string"})

    try:
        validate_url(url)
    except ValueError as e:
        return json.dumps({"error": str(e)})

    # --- Validate country (OFAC) ---
    country = args.get("country")
    if country:
        upper = country.upper()
        if upper in SANCTIONED_COUNTRIES:
            return json.dumps(
                {"error": f"Country '{upper}' is blocked (OFAC sanctioned country)"}
            )

    # --- Validate HTTP method ---
    method = (args.get("method") or "GET").upper()
    if method not in ALLOWED_METHODS:
        return json.dumps({
            "error": (
                f"HTTP method '{method}' is not allowed. "
                "Only GET, HEAD, OPTIONS are permitted."
            )
        })

    # --- Validate proxy type ---
    proxy_type = args.get("proxy_type") or "dc"
    if proxy_type not in ("dc", "residential"):
        return json.dumps({"error": "proxy_type must be 'dc' or 'residential'"})

    # --- Sanitise custom headers ---
    raw_headers = args.get("headers") or {}
    safe_headers: Dict[str, str] = {}
    for key, value in raw_headers.items():
        if key.lower() in _BLOCKED_HEADERS:
            continue
        # CRLF injection prevention
        if "\r" in key or "\n" in key or "\0" in key:
            continue
        val_str = str(value)
        if "\r" in val_str or "\n" in val_str or "\0" in val_str:
            continue
        safe_headers[key] = val_str

    # --- Build proxy URL ---
    try:
        proxy_host = os.environ.get("DOMINUSNODE_PROXY_HOST", "proxy.dominusnode.com")
        proxy_port = os.environ.get("DOMINUSNODE_PROXY_PORT", "8080")

        # Build proxy username for routing options
        parts: list[str] = []
        if proxy_type and proxy_type != "auto":
            parts.append(proxy_type)
        if country:
            parts.append(f"country-{country.upper()}")
        username = "-".join(parts) if parts else "auto"

        proxy_url = f"http://{username}:{auth.api_key}@{proxy_host}:{proxy_port}"

        # --- Execute proxied request ---
        with httpx.Client(
            proxy=proxy_url,
            timeout=30.0,
            follow_redirects=False,
            max_redirects=0,
        ) as proxy_client:
            resp = proxy_client.request(
                method=method,
                url=url,
                headers=safe_headers,
            )

            # Enforce response size limit
            if len(resp.content) > MAX_RESPONSE_BYTES:
                return json.dumps({"error": "Response body too large (exceeds 10MB limit)"})

            body = resp.text[:MAX_BODY_TRUNCATE]
            resp_headers = dict(resp.headers)

            # Scrub sensitive response headers
            for h in ("set-cookie", "www-authenticate", "proxy-authenticate"):
                resp_headers.pop(h, None)

            return json.dumps({
                "status": resp.status_code,
                "headers": resp_headers,
                "body": body,
            })

    except Exception as e:
        return json.dumps({
            "error": f"Proxy fetch failed: {_sanitize_error(str(e))}",
            "hint": "Ensure the Dominus Node proxy gateway is running and accessible.",
        })


# ---------------------------------------------------------------------------
# Tool: get_proxy_config
# ---------------------------------------------------------------------------


def get_proxy_config(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Retrieve the Dominus Node proxy endpoint configuration.

    Returns proxy host/port, supported countries, geo-targeting capabilities,
    and rotation interval settings.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with proxy configuration data.
    """
    try:
        result = auth.api_request("GET", "/api/proxy/config")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: list_sessions
# ---------------------------------------------------------------------------


def list_sessions(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """List currently active proxy sessions.

    Returns information about all active sessions including session IDs,
    proxy types, bytes transferred, and duration. Note: upstream proxy IPs
    are never exposed.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with active session data.
    """
    try:
        result = auth.api_request("GET", "/api/sessions/active")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: get_proxy_status
# ---------------------------------------------------------------------------


def get_proxy_status(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get the Dominus Node proxy gateway health and pool status.

    Returns overall gateway health, pool sizes for datacenter and residential
    proxies, rotation interval, and any degraded-state indicators.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with proxy status data.
    """
    try:
        result = auth.api_request("GET", "/api/proxy/status")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table (used by Agent Zero's tool loader)
# ---------------------------------------------------------------------------

TOOLS = {
    "proxied_fetch": {
        "function": proxied_fetch,
        "description": (
            "Fetch a URL through the Dominus Node rotating proxy network. "
            "Routes traffic through datacenter or residential proxy IPs "
            "with optional country-level geo-targeting. "
            "Only read-only HTTP methods (GET, HEAD, OPTIONS) are permitted."
        ),
        "parameters": {
            "url": {"type": "string", "required": True, "description": "The URL to fetch"},
            "method": {"type": "string", "required": False, "description": "HTTP method (GET/HEAD/OPTIONS). Default: GET"},
            "country": {"type": "string", "required": False, "description": "Two-letter country code (e.g. US, GB, DE)"},
            "proxy_type": {"type": "string", "required": False, "description": "dc or residential. Default: dc"},
            "headers": {"type": "object", "required": False, "description": "Custom headers to forward"},
        },
    },
    "get_proxy_config": {
        "function": get_proxy_config,
        "description": (
            "Get the Dominus Node proxy configuration including endpoints, "
            "supported countries, and geo-targeting capabilities."
        ),
        "parameters": {},
    },
    "list_sessions": {
        "function": list_sessions,
        "description": (
            "List currently active proxy sessions with byte transfer stats."
        ),
        "parameters": {},
    },
    "get_proxy_status": {
        "function": get_proxy_status,
        "description": (
            "Get proxy gateway health and pool status including datacenter "
            "and residential pool sizes and rotation interval."
        ),
        "parameters": {},
    },
}
