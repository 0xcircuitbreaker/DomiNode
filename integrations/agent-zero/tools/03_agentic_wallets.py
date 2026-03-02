"""Agent Zero tools: agentic wallet CRUD, funding, freeze/unfreeze, policy.

Agentic wallets are server-side custodial sub-wallets with per-transaction
spending limits, funded from the user's main wallet. They allow AI agents
to operate with bounded budgets.

Tools:
    - ``create_agentic_wallet`` -- Create a new sub-wallet with label and limit
    - ``fund_agentic_wallet`` -- Transfer funds from main wallet to sub-wallet
    - ``agentic_wallet_balance`` -- Check a specific sub-wallet's balance
    - ``list_agentic_wallets`` -- List all sub-wallets
    - ``agentic_transactions`` -- Get transaction history for a sub-wallet
    - ``freeze_agentic_wallet`` -- Freeze (pause) a sub-wallet
    - ``unfreeze_agentic_wallet`` -- Unfreeze a sub-wallet
    - ``delete_agentic_wallet`` -- Delete a sub-wallet (refunds remaining balance)
    - ``update_wallet_policy`` -- Update daily limit and/or allowed domains

Security:
    - Label sanitisation (length, control character validation)
    - Amount range validation (1 to 2,147,483,647 cents)
    - Daily limit validation (1 to 1,000,000 cents)
    - Allowed domains validation (max 100 entries, valid domain format)
    - Credential scrubbing in all error messages
    - Wallet must be unfrozen before deletion
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)
_DOMAIN_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


def _validate_label(label: Any) -> str | None:
    """Validate a wallet label, returning an error message or None if valid."""
    if not label or not isinstance(label, str):
        return "label is required and must be a string"
    if len(label) > 100:
        return "label must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in label):
        return "label contains invalid control characters"
    return None


def _validate_wallet_id(wallet_id: Any) -> str | None:
    """Validate a wallet_id, returning an error message or None if valid."""
    if not wallet_id or not isinstance(wallet_id, str):
        return "wallet_id is required and must be a string"
    if not _UUID_RE.match(wallet_id):
        return "wallet_id must be a valid UUID"
    return None


def _validate_amount_cents(amount_cents: Any) -> str | None:
    """Validate amount_cents, returning an error message or None if valid."""
    if (
        isinstance(amount_cents, bool)
        or not isinstance(amount_cents, int)
        or amount_cents <= 0
        or amount_cents > 2_147_483_647
    ):
        return "amount_cents must be a positive integer <= 2,147,483,647"
    return None


def _validate_daily_limit_cents(daily_limit_cents: Any) -> str | None:
    """Validate daily_limit_cents, returning an error message or None if valid."""
    if (
        isinstance(daily_limit_cents, bool)
        or not isinstance(daily_limit_cents, int)
        or daily_limit_cents <= 0
        or daily_limit_cents > 1_000_000
    ):
        return "daily_limit_cents must be a positive integer <= 1,000,000"
    return None


def _validate_allowed_domains(allowed_domains: Any) -> str | None:
    """Validate allowed_domains list, returning an error message or None if valid."""
    if not isinstance(allowed_domains, list):
        return "allowed_domains must be a list of strings"
    if len(allowed_domains) > 100:
        return "allowed_domains must have 100 or fewer entries"
    for domain in allowed_domains:
        if not isinstance(domain, str):
            return "each entry in allowed_domains must be a string"
        if len(domain) > 253:
            return "each domain must be 253 characters or fewer"
        if not _DOMAIN_RE.match(domain):
            return f"invalid domain format: {domain}"
    return None


# ---------------------------------------------------------------------------
# Tool: create_agentic_wallet
# ---------------------------------------------------------------------------


def create_agentic_wallet(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a new agentic sub-wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``label`` (str, required): Human-readable name (max 100 chars).
            - ``spending_limit_cents`` (int, required): Per-transaction
              spending limit in cents. Must be > 0 and <= 2,147,483,647.
            - ``daily_limit_cents`` (int, optional): Daily budget cap in
              cents. Must be > 0 and <= 1,000,000.
            - ``allowed_domains`` (list[str], optional): Restrict proxy
              usage to these domains only (max 100, each <= 253 chars).

    Returns:
        JSON string with the created wallet details (id, label, balance, limit).
    """
    label = args.get("label")
    err = _validate_label(label)
    if err:
        return json.dumps({"error": err})

    spending_limit_cents = args.get("spending_limit_cents")
    err = _validate_amount_cents(spending_limit_cents)
    if err:
        return json.dumps({"error": f"spending_limit_cents: {err}"})

    body: Dict[str, Any] = {
        "label": label,
        "spendingLimitCents": spending_limit_cents,
    }

    daily_limit_cents = args.get("daily_limit_cents")
    if daily_limit_cents is not None:
        err = _validate_daily_limit_cents(daily_limit_cents)
        if err:
            return json.dumps({"error": err})
        body["dailyLimitCents"] = daily_limit_cents

    allowed_domains = args.get("allowed_domains")
    if allowed_domains is not None:
        err = _validate_allowed_domains(allowed_domains)
        if err:
            return json.dumps({"error": err})
        body["allowedDomains"] = allowed_domains

    try:
        result = auth.api_request("POST", "/api/agent-wallet", body)
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: fund_agentic_wallet
# ---------------------------------------------------------------------------


def fund_agentic_wallet(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Transfer funds from the main wallet to an agentic sub-wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.
            - ``amount_cents`` (int, required): Amount to transfer in cents.

    Returns:
        JSON string with updated wallet balance.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    amount_cents = args.get("amount_cents")
    err = _validate_amount_cents(amount_cents)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "POST",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}/fund",
            {"amountCents": amount_cents},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: agentic_wallet_balance
# ---------------------------------------------------------------------------


def agentic_wallet_balance(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Check the balance and details of a specific agentic sub-wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.

    Returns:
        JSON string with wallet details (id, label, balance, status, limit).
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "GET",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: list_agentic_wallets
# ---------------------------------------------------------------------------


def list_agentic_wallets(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """List all agentic sub-wallets for the authenticated user.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with an array of wallet objects.
    """
    try:
        result = auth.api_request("GET", "/api/agent-wallet")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: agentic_transactions
# ---------------------------------------------------------------------------


def agentic_transactions(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get transaction history for a specific agentic sub-wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.
            - ``limit`` (int, optional): Maximum transactions to return
              (1-100). Default: 20.

    Returns:
        JSON string with transaction history.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    limit = args.get("limit")
    qs = ""
    if limit is not None:
        if not isinstance(limit, int) or limit < 1 or limit > 100:
            return json.dumps(
                {"error": "limit must be an integer between 1 and 100"}
            )
        qs = f"?limit={limit}"

    try:
        result = auth.api_request(
            "GET",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}/transactions{qs}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: freeze_agentic_wallet
# ---------------------------------------------------------------------------


def freeze_agentic_wallet(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Freeze (pause) an agentic sub-wallet.

    A frozen wallet cannot be used for proxy spending until it is unfrozen.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.

    Returns:
        JSON string confirming the freeze operation.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "POST",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}/freeze",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: unfreeze_agentic_wallet
# ---------------------------------------------------------------------------


def unfreeze_agentic_wallet(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Unfreeze a previously frozen agentic sub-wallet.

    Restores the wallet to active status so it can be used for spending.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.

    Returns:
        JSON string confirming the unfreeze operation.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "POST",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}/unfreeze",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: delete_agentic_wallet
# ---------------------------------------------------------------------------


def delete_agentic_wallet(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Delete an agentic sub-wallet and refund remaining balance.

    The wallet must be in ``active`` status (not frozen) before it can be
    deleted. Any remaining balance is returned to the main wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.

    Returns:
        JSON string confirming deletion and refunded amount.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "DELETE",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: update_wallet_policy
# ---------------------------------------------------------------------------


def update_wallet_policy(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Update policy fields on an agentic sub-wallet.

    Allows setting or clearing the daily budget cap and/or the list of
    allowed proxy domains.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``wallet_id`` (str, required): Sub-wallet UUID.
            - ``daily_limit_cents`` (int or None, optional): Daily budget
              cap in cents.  Pass ``None`` to clear.  Must be > 0 and
              <= 1,000,000 when set.
            - ``allowed_domains`` (list[str] or None, optional): Restrict
              proxy to these domains.  Pass ``None`` to clear.  Max 100
              entries, each <= 253 chars, valid domain format.

    Returns:
        JSON string with updated wallet policy details.
    """
    wallet_id = args.get("wallet_id")
    err = _validate_wallet_id(wallet_id)
    if err:
        return json.dumps({"error": err})

    body: Dict[str, Any] = {}

    daily_limit_cents = args.get("daily_limit_cents")
    if "daily_limit_cents" in args:
        if daily_limit_cents is not None:
            err = _validate_daily_limit_cents(daily_limit_cents)
            if err:
                return json.dumps({"error": err})
        body["dailyLimitCents"] = daily_limit_cents

    allowed_domains = args.get("allowed_domains")
    if "allowed_domains" in args:
        if allowed_domains is not None:
            err = _validate_allowed_domains(allowed_domains)
            if err:
                return json.dumps({"error": err})
        body["allowedDomains"] = allowed_domains

    if not body:
        return json.dumps(
            {"error": "At least one of daily_limit_cents or allowed_domains must be provided"}
        )

    try:
        result = auth.api_request(
            "PATCH",
            f"/api/agent-wallet/{auth.url_encode(wallet_id)}/policy",
            body,
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "create_agentic_wallet": {
        "function": create_agentic_wallet,
        "description": (
            "Create a new agentic sub-wallet with a label and per-transaction "
            "spending limit. Funded from the main wallet."
        ),
        "parameters": {
            "label": {
                "type": "string",
                "required": True,
                "description": "Human-readable wallet name (max 100 chars)",
            },
            "spending_limit_cents": {
                "type": "integer",
                "required": True,
                "description": "Per-transaction spending limit in cents",
            },
            "daily_limit_cents": {
                "type": "integer",
                "required": False,
                "description": "Daily budget cap in cents (> 0, <= 1,000,000)",
            },
            "allowed_domains": {
                "type": "array",
                "required": False,
                "description": "Restrict proxy to these domains only (max 100)",
            },
        },
    },
    "fund_agentic_wallet": {
        "function": fund_agentic_wallet,
        "description": (
            "Transfer funds from the main wallet to an agentic sub-wallet."
        ),
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
            "amount_cents": {"type": "integer", "required": True, "description": "Amount in cents to transfer"},
        },
    },
    "agentic_wallet_balance": {
        "function": agentic_wallet_balance,
        "description": "Check the balance and status of an agentic sub-wallet.",
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
        },
    },
    "list_agentic_wallets": {
        "function": list_agentic_wallets,
        "description": "List all agentic sub-wallets for the current user.",
        "parameters": {},
    },
    "agentic_transactions": {
        "function": agentic_transactions,
        "description": "Get transaction history for an agentic sub-wallet.",
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
            "limit": {"type": "integer", "required": False, "description": "Max results (1-100, default 20)"},
        },
    },
    "freeze_agentic_wallet": {
        "function": freeze_agentic_wallet,
        "description": "Freeze (pause) an agentic sub-wallet to prevent spending.",
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
        },
    },
    "unfreeze_agentic_wallet": {
        "function": unfreeze_agentic_wallet,
        "description": "Unfreeze a frozen agentic sub-wallet to re-enable spending.",
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
        },
    },
    "delete_agentic_wallet": {
        "function": delete_agentic_wallet,
        "description": (
            "Delete an agentic sub-wallet. Must be active (not frozen). "
            "Remaining balance is refunded to the main wallet."
        ),
        "parameters": {
            "wallet_id": {"type": "string", "required": True, "description": "Sub-wallet UUID"},
        },
    },
    "update_wallet_policy": {
        "function": update_wallet_policy,
        "description": (
            "Update policy fields (daily limit, allowed domains) on an "
            "agentic sub-wallet."
        ),
        "parameters": {
            "wallet_id": {
                "type": "string",
                "required": True,
                "description": "Sub-wallet UUID",
            },
            "daily_limit_cents": {
                "type": "integer",
                "required": False,
                "description": "Daily budget cap in cents (> 0, <= 1,000,000). null to clear.",
            },
            "allowed_domains": {
                "type": "array",
                "required": False,
                "description": "Restrict proxy to these domains (max 100). null to clear.",
            },
        },
    },
}
