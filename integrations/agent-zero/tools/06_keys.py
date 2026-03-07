"""Agent Zero tools: API key management.

Tools:
    - ``list_keys`` -- List all personal API keys
    - ``create_key`` -- Create a new personal API key
    - ``revoke_key`` -- Revoke (delete) a personal API key

Security:
    - Label sanitisation (length, control character validation)
    - UUID validation for key IDs
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


def _validate_label(label: Any) -> str | None:
    """Validate a key label, returning an error message or None if valid."""
    if not label or not isinstance(label, str):
        return "label is required and must be a string"
    if len(label) > 100:
        return "label must be 100 characters or fewer"
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in label):
        return "label contains invalid control characters"
    return None


# ---------------------------------------------------------------------------
# Tool: list_keys
# ---------------------------------------------------------------------------


def list_keys(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """List all personal API keys.

    Returns key metadata including labels, creation dates, and
    last-used timestamps. Key secrets are never returned.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with an array of API key objects.
    """
    try:
        result = auth.api_request("GET", "/api/keys")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: create_key
# ---------------------------------------------------------------------------


def create_key(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Create a new personal API key.

    The full key value is returned only once in the response. Store it
    securely as it cannot be retrieved again.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``label`` (str, required): Human-readable label for the key
              (max 100 characters).

    Returns:
        JSON string with the new API key (shown once).
    """
    label = args.get("label")
    err = _validate_label(label)
    if err:
        return json.dumps({"error": err})

    try:
        result = auth.api_request("POST", "/api/keys", {"label": label})
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: revoke_key
# ---------------------------------------------------------------------------


def revoke_key(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Revoke (delete) a personal API key.

    The key is immediately invalidated. Any applications using this key
    will lose access.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``key_id`` (str, required): API key UUID to revoke.

    Returns:
        JSON string confirming the key revocation.
    """
    key_id = args.get("key_id")
    if not key_id or not isinstance(key_id, str):
        return json.dumps({"error": "key_id is required and must be a string"})
    if not _UUID_RE.match(key_id):
        return json.dumps({"error": "key_id must be a valid UUID"})

    try:
        result = auth.api_request(
            "DELETE",
            f"/api/keys/{auth.url_encode(key_id)}",
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "list_keys": {
        "function": list_keys,
        "description": (
            "List all personal API keys with labels, creation dates, "
            "and last-used timestamps."
        ),
        "parameters": {},
    },
    "create_key": {
        "function": create_key,
        "description": (
            "Create a new personal API key. The key value is shown only once."
        ),
        "parameters": {
            "label": {
                "type": "string",
                "required": True,
                "description": "Key label (max 100 characters)",
            },
        },
    },
    "revoke_key": {
        "function": revoke_key,
        "description": (
            "Revoke a personal API key. The key is immediately invalidated."
        ),
        "parameters": {
            "key_id": {
                "type": "string",
                "required": True,
                "description": "API key UUID to revoke",
            },
        },
    },
}
