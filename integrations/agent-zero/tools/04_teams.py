"""Agent Zero tools: team management, shared wallets, API keys.

Teams allow multiple users to share a wallet for proxy billing, with
owner/admin/member role hierarchy and email-based invitations.

Tools:
    - ``create_team`` -- Create a new team with optional member limit
    - ``list_teams`` -- List all teams the user belongs to
    - ``team_details`` -- Get details for a specific team
    - ``team_fund`` -- Transfer funds from personal wallet to team wallet
    - ``team_create_key`` -- Create a team API key
    - ``team_usage`` -- Get team wallet transaction history
    - ``update_team`` -- Update team name or member limit
    - ``update_team_member_role`` -- Change a member's role (admin/member)

Security:
    - Name/label sanitisation (length, control characters)
    - UUID format validation for team_id and user_id
    - Role enum validation (member/admin only)
    - Amount range validation for funding
    - Credential scrubbing in all error messages
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_VALID_ROLES = frozenset({"member", "admin"})


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


def _validate_team_id(team_id: Any) -> str | None:
    """Validate team_id, returning an error message or None if valid."""
    if not team_id or not isinstance(team_id, str):
        return "team_id is required and must be a string"
    if not _UUID_RE.match(team_id):
        return "team_id must be a valid UUID"
    return None


def _validate_name(name: Any, field: str = "name") -> str | None:
    """Validate a name/label field for length and control characters."""
    if not name or not isinstance(name, str):
        return f"{field} is required and must be a string"
    if len(name) > 100:
        return f"{field} must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in name):
        return f"{field} contains invalid control characters"
    return None


# ---------------------------------------------------------------------------
# Tool: create_team
# ---------------------------------------------------------------------------


def create_team(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a new team.

    The authenticated user becomes the team owner. A shared team wallet
    is created automatically.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``name`` (str, required): Team name (max 100 chars).
            - ``max_members`` (int, optional): Maximum team size (1-100).

    Returns:
        JSON string with created team details.
    """
    name = args.get("name")
    err = _validate_name(name)
    if err:
        return json.dumps({"error": err})

    body: Dict[str, Any] = {"name": name}

    max_members = args.get("max_members")
    if max_members is not None:
        if not isinstance(max_members, int) or max_members < 1 or max_members > 100:
            return json.dumps(
                {"error": "max_members must be an integer between 1 and 100"}
            )
        body["maxMembers"] = max_members

    try:
        result = auth.api_request("POST", "/api/teams", body)
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: list_teams
# ---------------------------------------------------------------------------


def list_teams(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """List all teams the authenticated user belongs to.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with an array of team objects.
    """
    try:
        result = auth.api_request("GET", "/api/teams")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: team_details
# ---------------------------------------------------------------------------


def team_details(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get details for a specific team.

    Returns team metadata, member list, wallet balance, and active API keys.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.

    Returns:
        JSON string with team details.
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "GET", f"/api/teams/{auth.url_encode(team_id)}"
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: team_fund
# ---------------------------------------------------------------------------


def team_fund(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Transfer funds from the user's personal wallet to the team wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.
            - ``amount_cents`` (int, required): Amount in cents.
              Must be between 100 ($1) and 1,000,000 ($10,000).

    Returns:
        JSON string with updated team wallet balance.
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
    if err:
        return json.dumps({"error": err})

    amount_cents = args.get("amount_cents")
    if (
        not isinstance(amount_cents, int)
        or amount_cents < 100
        or amount_cents > 1_000_000
    ):
        return json.dumps({
            "error": (
                "amount_cents must be an integer between 100 ($1) "
                "and 1,000,000 ($10,000)"
            )
        })

    try:
        result = auth.api_request(
            "POST",
            f"/api/teams/{auth.url_encode(team_id)}/wallet/fund",
            {"amountCents": amount_cents},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: team_create_key
# ---------------------------------------------------------------------------


def team_create_key(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a team API key.

    Team API keys bill proxy usage to the team wallet instead of the
    individual user's wallet.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.
            - ``label`` (str, required): Key label (max 100 chars).

    Returns:
        JSON string with the newly created API key (shown once).
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
    if err:
        return json.dumps({"error": err})

    label = args.get("label")
    err = _validate_name(label, field="label")
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request(
            "POST",
            f"/api/teams/{auth.url_encode(team_id)}/keys",
            {"label": label},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: team_usage
# ---------------------------------------------------------------------------


def team_usage(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get team wallet transaction history.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.
            - ``limit`` (int, optional): Maximum transactions (1-100).

    Returns:
        JSON string with team transaction history.
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
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
            f"/api/teams/{auth.url_encode(team_id)}/wallet/transactions{qs}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: update_team
# ---------------------------------------------------------------------------


def update_team(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Update team name or maximum member count.

    At least one of ``name`` or ``max_members`` must be provided.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.
            - ``name`` (str, optional): New team name (max 100 chars).
            - ``max_members`` (int, optional): New max members (1-100).

    Returns:
        JSON string with updated team details.
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
    if err:
        return json.dumps({"error": err})

    body: Dict[str, Any] = {}

    name = args.get("name")
    if name is not None:
        if not isinstance(name, str) or len(name) == 0:
            return json.dumps({"error": "name must be a non-empty string"})
        if len(name) > 100:
            return json.dumps({"error": "name must be 100 characters or fewer"})
        if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in name):
            return json.dumps(
                {"error": "name contains invalid control characters"}
            )
        body["name"] = name

    max_members = args.get("max_members")
    if max_members is not None:
        if not isinstance(max_members, int) or max_members < 1 or max_members > 100:
            return json.dumps(
                {"error": "max_members must be an integer between 1 and 100"}
            )
        body["maxMembers"] = max_members

    if not body:
        return json.dumps(
            {"error": "At least one of name or max_members must be provided"}
        )

    try:
        result = auth.api_request(
            "PATCH",
            f"/api/teams/{auth.url_encode(team_id)}",
            body,
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: update_team_member_role
# ---------------------------------------------------------------------------


def update_team_member_role(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Change a team member's role.

    Only team owners and admins can change roles. The owner role cannot
    be assigned through this endpoint.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``team_id`` (str, required): Team UUID.
            - ``user_id`` (str, required): Target member's UUID.
            - ``role`` (str, required): New role (``member`` or ``admin``).

    Returns:
        JSON string confirming the role change.
    """
    team_id = args.get("team_id")
    err = _validate_team_id(team_id)
    if err:
        return json.dumps({"error": err})

    user_id = args.get("user_id")
    if not user_id or not isinstance(user_id, str):
        return json.dumps({"error": "user_id is required and must be a string"})
    if not _UUID_RE.match(user_id):
        return json.dumps({"error": "user_id must be a valid UUID"})

    role = args.get("role")
    if not role or not isinstance(role, str):
        return json.dumps({"error": "role is required and must be a string"})
    if role not in _VALID_ROLES:
        return json.dumps({"error": "role must be 'member' or 'admin'"})

    try:
        result = auth.api_request(
            "PATCH",
            f"/api/teams/{auth.url_encode(team_id)}/members/{auth.url_encode(user_id)}",
            {"role": role},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "create_team": {
        "function": create_team,
        "description": "Create a new team with a shared wallet for proxy billing.",
        "parameters": {
            "name": {"type": "string", "required": True, "description": "Team name (max 100 chars)"},
            "max_members": {"type": "integer", "required": False, "description": "Max team size (1-100)"},
        },
    },
    "list_teams": {
        "function": list_teams,
        "description": "List all teams the current user belongs to.",
        "parameters": {},
    },
    "team_details": {
        "function": team_details,
        "description": "Get full details for a team including members and wallet.",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
        },
    },
    "team_fund": {
        "function": team_fund,
        "description": "Transfer funds from personal wallet to team wallet ($1-$10,000).",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
            "amount_cents": {"type": "integer", "required": True, "description": "Amount in cents"},
        },
    },
    "team_create_key": {
        "function": team_create_key,
        "description": "Create a team API key that bills to the team wallet.",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
            "label": {"type": "string", "required": True, "description": "Key label (max 100 chars)"},
        },
    },
    "team_usage": {
        "function": team_usage,
        "description": "Get team wallet transaction history.",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
            "limit": {"type": "integer", "required": False, "description": "Max results (1-100)"},
        },
    },
    "update_team": {
        "function": update_team,
        "description": "Update team name or member limit.",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
            "name": {"type": "string", "required": False, "description": "New team name"},
            "max_members": {"type": "integer", "required": False, "description": "New max members (1-100)"},
        },
    },
    "update_team_member_role": {
        "function": update_team_member_role,
        "description": "Change a team member's role to admin or member.",
        "parameters": {
            "team_id": {"type": "string", "required": True, "description": "Team UUID"},
            "user_id": {"type": "string", "required": True, "description": "Member's user UUID"},
            "role": {"type": "string", "required": True, "description": "New role: member or admin"},
        },
    },
}
