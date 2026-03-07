"""Agent Zero tools: account registration, login, profile, email verification.

Tools:
    - ``register`` -- Register a new account (unauthenticated)
    - ``login`` -- Log in with email and password (unauthenticated)
    - ``get_account_info`` -- Get current account profile
    - ``verify_email`` -- Verify email with token (unauthenticated)
    - ``resend_verification`` -- Resend email verification link
    - ``update_password`` -- Change account password

Security:
    - Email format and length validation
    - Password length validation (8-128 characters)
    - Verification token sanitisation (no control characters)
    - Credential scrubbing in all error messages
    - register/login/verify_email are unauthenticated (use rawRequest)
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict

from shared import DominusNodeAuth
from shared.constants import CREDENTIAL_RE

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sanitize_error(message: str) -> str:
    """Remove Dominus Node API key patterns from error messages."""
    return CREDENTIAL_RE.sub("***", message)


def _validate_email(email: Any) -> str | None:
    """Validate an email address, returning an error or None."""
    if not email or not isinstance(email, str):
        return "email is required and must be a string"
    trimmed = email.strip()
    if not _EMAIL_RE.match(trimmed):
        return "Invalid email address"
    if len(trimmed) > 254:
        return "Email address too long (max 254 characters)"
    return None


def _validate_password(password: Any) -> str | None:
    """Validate a password, returning an error or None."""
    if not password or not isinstance(password, str):
        return "password is required and must be a string"
    if len(password) < 8:
        return "Password must be at least 8 characters"
    if len(password) > 128:
        return "Password must be at most 128 characters"
    return None


# ---------------------------------------------------------------------------
# Tool: register
# ---------------------------------------------------------------------------


def register(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Register a new Dominus Node account.

    This is an unauthenticated endpoint. On success, returns a
    confirmation message; the user must verify their email before
    the account is fully active.

    Args:
        auth: Dominus Node helper (used for base_url and HTTP utilities).
        args: Tool arguments:
            - ``email`` (str, required): Email address for the new account.
            - ``password`` (str, required): Password (8-128 characters).

    Returns:
        JSON string with registration result or error.
    """
    email = args.get("email")
    err = _validate_email(email)
    if err:
        return json.dumps({"error": err})

    password = args.get("password")
    err = _validate_password(password)
    if err:
        return json.dumps({"error": err})

    try:
        import httpx
        from shared.auth import _USER_AGENT

        with httpx.Client(timeout=auth.timeout, follow_redirects=False) as client:
            resp = client.post(
                f"{auth.base_url}/api/auth/register",
                json={"email": email.strip(), "password": password},
                headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
            )
            if resp.status_code >= 400:
                body = auth.sanitize_error(resp.text[:500])
                return json.dumps({"error": f"Registration failed ({resp.status_code}): {body}"})
            if resp.text:
                return json.dumps(auth.safe_json_parse(resp.text))
            return json.dumps({"success": True})
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: login
# ---------------------------------------------------------------------------


def login(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Log in to a Dominus Node account.

    This is an unauthenticated endpoint. On success, returns an access
    token and refresh token.

    Args:
        auth: Dominus Node helper (used for base_url and HTTP utilities).
        args: Tool arguments:
            - ``email`` (str, required): Account email address.
            - ``password`` (str, required): Account password.

    Returns:
        JSON string with tokens or error.
    """
    email = args.get("email")
    err = _validate_email(email)
    if err:
        return json.dumps({"error": err})

    password = args.get("password")
    err = _validate_password(password)
    if err:
        return json.dumps({"error": err})

    try:
        import httpx
        from shared.auth import _USER_AGENT

        with httpx.Client(timeout=auth.timeout, follow_redirects=False) as client:
            resp = client.post(
                f"{auth.base_url}/api/auth/login",
                json={"email": email.strip(), "password": password},
                headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
            )
            if resp.status_code >= 400:
                body = auth.sanitize_error(resp.text[:500])
                return json.dumps({"error": f"Login failed ({resp.status_code}): {body}"})
            if resp.text:
                return json.dumps(auth.safe_json_parse(resp.text))
            return json.dumps({"success": True})
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: get_account_info
# ---------------------------------------------------------------------------


def get_account_info(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Get the current account profile information.

    Returns account email, plan, email verification status, and
    creation date.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string with account profile data.
    """
    try:
        result = auth.api_request("GET", "/api/auth/me")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: verify_email
# ---------------------------------------------------------------------------


def verify_email(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Verify an email address using a verification token.

    This is an unauthenticated endpoint. The token is sent to the
    user's email during registration.

    Args:
        auth: Dominus Node helper (used for base_url and HTTP utilities).
        args: Tool arguments:
            - ``token`` (str, required): Email verification token.

    Returns:
        JSON string confirming verification or error.
    """
    token = args.get("token")
    if not token or not isinstance(token, str) or token.strip() == "":
        return json.dumps({"error": "token is required and must be a non-empty string"})
    if any(0 <= ord(c) <= 0x1F or ord(c) == 0x7F for c in token):
        return json.dumps({"error": "Token contains invalid control characters"})

    try:
        import httpx
        from shared.auth import _USER_AGENT

        with httpx.Client(timeout=auth.timeout, follow_redirects=False) as client:
            resp = client.post(
                f"{auth.base_url}/api/auth/verify-email",
                json={"token": token.strip()},
                headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
            )
            if resp.status_code >= 400:
                body = auth.sanitize_error(resp.text[:500])
                return json.dumps({"error": f"Verification failed ({resp.status_code}): {body}"})
            if resp.text:
                return json.dumps(auth.safe_json_parse(resp.text))
            return json.dumps({"success": True})
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: resend_verification
# ---------------------------------------------------------------------------


def resend_verification(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Resend the email verification link.

    Sends a new verification email to the authenticated user's email
    address.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments (none required).

    Returns:
        JSON string confirming the email was resent.
    """
    try:
        result = auth.api_request("POST", "/api/auth/resend-verification")
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Tool: update_password
# ---------------------------------------------------------------------------


def update_password(
    auth: DominusNodeAuth,
    args: Dict[str, Any],
) -> str:
    """Change the account password.

    Requires the current password for verification.

    Args:
        auth: Authenticated Dominus Node helper.
        args: Tool arguments:
            - ``current_password`` (str, required): Current password.
            - ``new_password`` (str, required): New password (8-128 chars).

    Returns:
        JSON string confirming the password change.
    """
    current_password = args.get("current_password")
    err = _validate_password(current_password)
    if err:
        return json.dumps({"error": f"current_password: {err}"})

    new_password = args.get("new_password")
    err = _validate_password(new_password)
    if err:
        return json.dumps({"error": f"new_password: {err}"})

    try:
        result = auth.api_request(
            "POST",
            "/api/auth/change-password",
            {"currentPassword": current_password, "newPassword": new_password},
        )
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": _sanitize_error(str(e))})


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

TOOLS = {
    "register": {
        "function": register,
        "description": (
            "Register a new Dominus Node account. No authentication required. "
            "User must verify email after registration."
        ),
        "parameters": {
            "email": {"type": "string", "required": True, "description": "Email address for the new account"},
            "password": {"type": "string", "required": True, "description": "Password (8-128 characters)"},
        },
    },
    "login": {
        "function": login,
        "description": (
            "Log in to a Dominus Node account with email and password. "
            "No authentication required. Returns access and refresh tokens."
        ),
        "parameters": {
            "email": {"type": "string", "required": True, "description": "Account email address"},
            "password": {"type": "string", "required": True, "description": "Account password"},
        },
    },
    "get_account_info": {
        "function": get_account_info,
        "description": (
            "Get current account profile including email, plan, "
            "verification status, and creation date."
        ),
        "parameters": {},
    },
    "verify_email": {
        "function": verify_email,
        "description": (
            "Verify an email address using the token sent during registration. "
            "No authentication required."
        ),
        "parameters": {
            "token": {"type": "string", "required": True, "description": "Email verification token"},
        },
    },
    "resend_verification": {
        "function": resend_verification,
        "description": "Resend the email verification link to the current user's email.",
        "parameters": {},
    },
    "update_password": {
        "function": update_password,
        "description": "Change the account password. Requires current password for verification.",
        "parameters": {
            "current_password": {"type": "string", "required": True, "description": "Current password"},
            "new_password": {"type": "string", "required": True, "description": "New password (8-128 characters)"},
        },
    },
}
