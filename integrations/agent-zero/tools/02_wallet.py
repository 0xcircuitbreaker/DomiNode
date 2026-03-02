"""Agent Zero tools: wallet balance, usage statistics, PayPal top-up.

Tools:
    - ``check_balance`` -- Get current wallet balance
    - ``check_usage`` -- Get proxy usage statistics for a time period
    - ``topup_paypal`` -- Create a PayPal checkout session for wallet top-up

Security:
    - Credential scrubbing in all error messages
    - Amount validation for PayPal top-up (500-1,000,000 cents)
    - Period-to-date-range conversion (backend uses since/until ISO dates)
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from urllib.parse import quote

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

# ---------------------------------------------------------------------------
# Helper: sanitise error messages
# ---------------------------------------------------------------------------


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Helper: convert period name to ISO date range
# ---------------------------------------------------------------------------


def _period_to_date_range(period: str) -> Dict[str, str]:
    """Convert a human-friendly period name to ISO 8601 date range.

    Supported periods: ``day``, ``week``, ``month`` (default).
    The backend expects ``since`` and ``until`` query parameters as
    ISO 8601 timestamps, not an integer ``days`` value.
    """
    now = datetime.now(timezone.utc)
    until = now.isoformat()

    if period == "day":
        since = (now - timedelta(days=1)).isoformat()
    elif period == "week":
        since = (now - timedelta(weeks=1)).isoformat()
    else:  # month (default)
        since = (now - timedelta(days=30)).isoformat()

    return {"since": since, "until": until}


# ---------------------------------------------------------------------------
# Tool: check_balance
# ---------------------------------------------------------------------------


def check_balance(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get the current wallet balance.

    Returns the wallet balance in cents and USD, plus any pending
    reservation amounts.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with wallet balance data.
    """
    try:
        result = auth.api_request("GET", "/api/wallet")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: check_usage
# ---------------------------------------------------------------------------


def check_usage(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get proxy usage statistics for a given time period.

    Returns bandwidth consumed, cost, and request count broken down by
    proxy type (datacenter vs residential).

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``period`` (str, optional): ``day``, ``week``, or ``month``.
              Default: ``month``.

    Returns:
        JSON string with usage statistics.
    """
    period = args.get("period", "month")
    if period not in ("day", "week", "month"):
        return json.dumps({"error": "period must be 'day', 'week', or 'month'"})

    date_range = _period_to_date_range(period)

    try:
        result = auth.api_request(
            "GET",
            f"/api/usage?since={quote(date_range['since'], safe='')}"
            f"&until={quote(date_range['until'], safe='')}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: topup_paypal
# ---------------------------------------------------------------------------


def topup_paypal(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a PayPal checkout session to top up the wallet.

    Initiates a PayPal payment flow for the specified amount. On successful
    payment, the wallet will be credited automatically via webhook.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``amount_cents`` (int, required): Amount in cents to add.
              Must be between 500 ($5) and 1,000,000 ($10,000).

    Returns:
        JSON string with the PayPal checkout URL and session details,
        or an error.
    """
    amount_cents = args.get("amount_cents")

    if not isinstance(amount_cents, int) or amount_cents < 500 or amount_cents > 1_000_000:
        return json.dumps({
            "error": (
                "amount_cents must be an integer between 500 ($5) "
                "and 1,000,000 ($10,000)"
            )
        })

    try:
        result = auth.api_request(
            "POST",
            "/api/wallet/topup/paypal",
            {"amountCents": amount_cents},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: x402_info
# ---------------------------------------------------------------------------


def x402_info(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get x402 micropayment protocol information.

    Returns details about x402 HTTP 402 Payment Required protocol support
    including facilitators, pricing, supported currencies, and payment
    options for AI agent micropayments.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with x402 protocol information.
    """
    try:
        result = auth.api_request("GET", "/api/x402/info")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "check_balance": {
        "function": check_balance,
        "description": (
            "Check the current Dominus Node wallet balance. Returns balance in "
            "cents and USD."
        ),
        "parameters": {},
    },
    "check_usage": {
        "function": check_usage,
        "description": (
            "Get proxy usage statistics (bandwidth, cost, requests) for a "
            "time period. Supports day, week, or month."
        ),
        "parameters": {
            "period": {
                "type": "string",
                "required": False,
                "description": "Time period: day, week, or month (default: month)",
            },
        },
    },
    "topup_paypal": {
        "function": topup_paypal,
        "description": (
            "Create a PayPal checkout session to add funds to the wallet. "
            "Amount must be between $5 and $10,000."
        ),
        "parameters": {
            "amount_cents": {
                "type": "integer",
                "required": True,
                "description": "Amount in cents ($1 = 100, $10 = 1000)",
            },
        },
    },
    "x402_info": {
        "function": x402_info,
        "description": (
            "Get x402 micropayment protocol information including supported "
            "facilitators, pricing, and payment options."
        ),
        "parameters": {},
    },
}
