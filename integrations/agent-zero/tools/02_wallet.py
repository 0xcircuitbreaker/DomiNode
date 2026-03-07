"""Agent Zero tools: wallet balance, usage statistics, payment top-ups, analytics.

Tools:
    - ``check_balance`` -- Get current wallet balance
    - ``check_usage`` -- Get proxy usage statistics for a time period
    - ``topup_paypal`` -- Create a PayPal checkout session for wallet top-up
    - ``topup_stripe`` -- Create a Stripe checkout session for wallet top-up
    - ``topup_crypto`` -- Create a crypto invoice for wallet top-up
    - ``x402_info`` -- Get x402 micropayment protocol information
    - ``get_transactions`` -- Get wallet transaction history
    - ``get_forecast`` -- Get spending forecast based on recent usage
    - ``check_payment`` -- Check the status of a crypto payment invoice
    - ``get_daily_usage`` -- Get daily bandwidth usage breakdown
    - ``get_top_hosts`` -- Get top hosts by bandwidth consumption

Security:
    - Credential scrubbing in all error messages
    - Amount validation for all top-up methods
    - Currency validation for crypto top-up
    - Period-to-date-range conversion (backend uses since/until ISO dates)
    - UUID validation for invoice IDs
    - NaN/Infinity guards on numeric inputs
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict
from urllib.parse import quote

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

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
# Tool: topup_stripe
# ---------------------------------------------------------------------------


def topup_stripe(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a Stripe checkout session to top up the wallet.

    Initiates a Stripe payment flow for the specified amount. On successful
    payment, the wallet will be credited automatically via webhook.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``amount_cents`` (int, required): Amount in cents to add.
              Must be between 500 ($5) and 100,000 ($1,000).

    Returns:
        JSON string with the Stripe checkout URL and session details,
        or an error.
    """
    amount_cents = args.get("amount_cents")

    if not isinstance(amount_cents, int) or isinstance(amount_cents, bool) or amount_cents < 500 or amount_cents > 100_000:
        return json.dumps({
            "error": (
                "amount_cents must be an integer between 500 ($5) "
                "and 100,000 ($1,000)"
            )
        })

    try:
        result = auth.api_request(
            "POST",
            "/api/wallet/topup/stripe",
            {"amountCents": amount_cents},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: topup_crypto
# ---------------------------------------------------------------------------

_VALID_CRYPTO_CURRENCIES = {
    "btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai",
    "bnb", "link",
}


def topup_crypto(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a crypto invoice to top up the wallet via NOWPayments.

    Initiates a crypto payment flow for the specified amount and currency.
    On successful payment, the wallet will be credited automatically via IPN.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``amount_usd`` (number, required): Amount in USD to add.
              Must be between 5 and 1,000.
            - ``currency`` (str, required): Cryptocurrency to pay with.
              One of: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI,
              BNB, LINK.

    Returns:
        JSON string with the crypto invoice details and payment URL,
        or an error.
    """
    amount_usd = args.get("amount_usd")
    currency = args.get("currency")

    if not isinstance(amount_usd, (int, float)) or isinstance(amount_usd, bool):
        return json.dumps({
            "error": "amount_usd must be a number between 5 and 1,000"
        })
    if not math.isfinite(amount_usd):
        return json.dumps({
            "error": "amount_usd must be a number between 5 and 1,000"
        })
    if amount_usd < 5 or amount_usd > 1000:
        return json.dumps({
            "error": "amount_usd must be a number between 5 and 1,000"
        })

    if not isinstance(currency, str) or currency.lower() not in _VALID_CRYPTO_CURRENCIES:
        return json.dumps({
            "error": (
                "currency must be one of: "
                "BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK"
            )
        })

    try:
        result = auth.api_request(
            "POST",
            "/api/wallet/topup/crypto",
            {"amountUsd": amount_usd, "currency": currency.lower()},
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
# Tool: get_transactions
# ---------------------------------------------------------------------------


def get_transactions(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get wallet transaction history.

    Returns a list of wallet transactions including top-ups, proxy usage
    charges, and agentic wallet transfers.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``limit`` (int, optional): Maximum transactions to return
              (1-100). Default: 20.

    Returns:
        JSON string with transaction history.
    """
    limit = args.get("limit")
    qs = ""
    if limit is not None:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )
        qs = f"?limit={limit}"

    try:
        result = auth.api_request("GET", f"/api/wallet/transactions{qs}")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: get_forecast
# ---------------------------------------------------------------------------


def get_forecast(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get a spending forecast based on recent usage patterns.

    Returns projected bandwidth consumption and costs based on
    historical usage trends.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with spending forecast data.
    """
    try:
        result = auth.api_request("GET", "/api/wallet/forecast")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: check_payment
# ---------------------------------------------------------------------------


def check_payment(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Check the status of a crypto payment invoice.

    Queries the payment status for a previously created crypto top-up
    invoice via NOWPayments.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``invoice_id`` (str, required): Invoice UUID to check.

    Returns:
        JSON string with the invoice payment status.
    """
    invoice_id = args.get("invoice_id")
    if not invoice_id or not isinstance(invoice_id, str):
        return json.dumps({"error": "invoice_id is required and must be a string"})
    if not _UUID_RE.match(invoice_id):
        return json.dumps({"error": "invoice_id must be a valid UUID"})

    try:
        result = auth.api_request(
            "GET",
            f"/api/wallet/topup/crypto/{quote(invoice_id, safe='')}/status",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: get_daily_usage
# ---------------------------------------------------------------------------


def get_daily_usage(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get daily bandwidth usage breakdown.

    Returns per-day bandwidth consumption for the specified number of
    trailing days, broken down by proxy type.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``days`` (int, optional): Number of trailing days (1-365).
              Default: 7.

    Returns:
        JSON string with daily usage breakdown.
    """
    days = args.get("days", 7)
    if not isinstance(days, int) or isinstance(days, bool):
        return json.dumps({"error": "days must be an integer between 1 and 365"})
    if math.isnan(days) if isinstance(days, float) else False:
        return json.dumps({"error": "days must be an integer between 1 and 365"})
    days = max(1, min(days, 365))

    try:
        result = auth.api_request("GET", f"/api/usage/daily?days={days}")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: get_top_hosts
# ---------------------------------------------------------------------------


def get_top_hosts(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get the top hosts by bandwidth usage.

    Shows which target domains consume the most proxy traffic, useful
    for cost analysis and optimisation.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``limit`` (int, optional): Number of top hosts to return
              (1-100). Default: 10.

    Returns:
        JSON string with top hosts by bandwidth.
    """
    limit = args.get("limit", 10)
    if not isinstance(limit, int) or isinstance(limit, bool):
        return json.dumps({"error": "limit must be an integer between 1 and 100"})
    limit = max(1, min(limit, 100))

    try:
        result = auth.api_request("GET", f"/api/usage/top-hosts?limit={limit}")
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
    "topup_stripe": {
        "function": topup_stripe,
        "description": (
            "Create a Stripe checkout session to add funds to the wallet. "
            "Amount must be between $5 and $1,000."
        ),
        "parameters": {
            "amount_cents": {
                "type": "integer",
                "required": True,
                "description": "Amount in cents ($5 = 500, $10 = 1000)",
            },
        },
    },
    "topup_crypto": {
        "function": topup_crypto,
        "description": (
            "Create a crypto invoice to add funds to the wallet via "
            "NOWPayments. Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, "
            "USDT, DAI, BNB, LINK."
        ),
        "parameters": {
            "amount_usd": {
                "type": "number",
                "required": True,
                "description": "Amount in USD (5-1,000)",
            },
            "currency": {
                "type": "string",
                "required": True,
                "description": "Cryptocurrency: BTC/ETH/LTC/XMR/ZEC/USDC/SOL/USDT/DAI/BNB/LINK",
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
    "get_transactions": {
        "function": get_transactions,
        "description": (
            "Get wallet transaction history including top-ups, proxy charges, "
            "and agentic wallet transfers."
        ),
        "parameters": {
            "limit": {
                "type": "integer",
                "required": False,
                "description": "Max transactions to return (1-100, default 20)",
            },
        },
    },
    "get_forecast": {
        "function": get_forecast,
        "description": (
            "Get a spending forecast based on recent usage patterns. "
            "Projects future bandwidth consumption and costs."
        ),
        "parameters": {},
    },
    "check_payment": {
        "function": check_payment,
        "description": (
            "Check the status of a crypto payment invoice created via "
            "topup_crypto. Returns payment status and confirmation details."
        ),
        "parameters": {
            "invoice_id": {
                "type": "string",
                "required": True,
                "description": "Invoice UUID to check",
            },
        },
    },
    "get_daily_usage": {
        "function": get_daily_usage,
        "description": (
            "Get daily bandwidth usage breakdown for the specified number of "
            "trailing days, broken down by proxy type."
        ),
        "parameters": {
            "days": {
                "type": "integer",
                "required": False,
                "description": "Number of trailing days (1-365, default 7)",
            },
        },
    },
    "get_top_hosts": {
        "function": get_top_hosts,
        "description": (
            "Get the top hosts by bandwidth usage. Shows which domains "
            "consume the most proxy traffic."
        ),
        "parameters": {
            "limit": {
                "type": "integer",
                "required": False,
                "description": "Number of top hosts to return (1-100, default 10)",
            },
        },
    },
}
