"""Agent Zero tools: plan management.

Tools:
    - ``get_plan`` -- Get the current user's active plan
    - ``list_plans`` -- List all available subscription plans
    - ``change_plan`` -- Change to a different subscription plan

Security:
    - UUID validation for plan IDs
    - Credential scrubbing in all error messages
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


# ---------------------------------------------------------------------------
# Tool: get_plan
# ---------------------------------------------------------------------------


def get_plan(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get the current user's active subscription plan.

    Returns plan name, bandwidth limits, pricing tier, and any
    included features.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with the current plan details.
    """
    try:
        result = auth.api_request("GET", "/api/plans/user/plan")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: list_plans
# ---------------------------------------------------------------------------


def list_plans(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """List all available subscription plans.

    Returns all plans with pricing, bandwidth limits, and feature
    comparisons.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with an array of plan objects.
    """
    try:
        result = auth.api_request("GET", "/api/plans")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: change_plan
# ---------------------------------------------------------------------------


def change_plan(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Change to a different subscription plan.

    Use ``list_plans`` first to see available options and their IDs.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``plan_id`` (str, required): UUID of the target plan.

    Returns:
        JSON string confirming the plan change.
    """
    plan_id = args.get("plan_id")
    if not plan_id or not isinstance(plan_id, str):
        return json.dumps({"error": "plan_id is required and must be a string"})
    if not _UUID_RE.match(plan_id):
        return json.dumps({"error": "plan_id must be a valid UUID"})

    try:
        result = auth.api_request(
            "PUT",
            "/api/plans/user/plan",
            {"planId": plan_id},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "get_plan": {
        "function": get_plan,
        "description": (
            "Get the current user's active subscription plan with pricing "
            "and bandwidth limits."
        ),
        "parameters": {},
    },
    "list_plans": {
        "function": list_plans,
        "description": (
            "List all available subscription plans with pricing and features."
        ),
        "parameters": {},
    },
    "change_plan": {
        "function": change_plan,
        "description": (
            "Change to a different subscription plan. "
            "Use list_plans to see available options."
        ),
        "parameters": {
            "plan_id": {
                "type": "string",
                "required": True,
                "description": "UUID of the target plan",
            },
        },
    },
}
