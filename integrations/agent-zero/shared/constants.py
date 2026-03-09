"""Shared constants for Dominus Node Agent Zero integration.

All security-sensitive values (blocked hostnames, sanctioned countries,
credential patterns) are centralised here so that every tool module
references the same authoritative definitions.
"""

from __future__ import annotations

import re
from typing import FrozenSet, Set

# ---------------------------------------------------------------------------
# OFAC sanctioned countries -- proxy traffic MUST NOT be routed here
# ---------------------------------------------------------------------------

SANCTIONED_COUNTRIES: FrozenSet[str] = frozenset({"CU", "IR", "KP", "RU", "SY"})

# ---------------------------------------------------------------------------
# Blocked hostnames for SSRF prevention
# ---------------------------------------------------------------------------

BLOCKED_HOSTNAMES: Set[str] = {
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "0.0.0.0",
    "[::]",
    "metadata.google.internal",
    "169.254.169.254",
}

# ---------------------------------------------------------------------------
# Allowed HTTP methods for proxied fetch (read-only only)
# ---------------------------------------------------------------------------

ALLOWED_METHODS: FrozenSet[str] = frozenset({"GET", "HEAD", "OPTIONS"})

# ---------------------------------------------------------------------------
# Response size limits
# ---------------------------------------------------------------------------

MAX_RESPONSE_BYTES: int = 10 * 1024 * 1024  # 10 MB
"""Maximum response body size accepted from upstream."""

MAX_BODY_TRUNCATE: int = 4000
"""Maximum characters of response body returned to the AI agent."""

# ---------------------------------------------------------------------------
# Credential sanitisation
# ---------------------------------------------------------------------------

CREDENTIAL_RE: re.Pattern[str] = re.compile(r"dn_(live|test|proxy)_[a-zA-Z0-9]+")
"""Regex matching Dominus Node API key patterns (dn_live_xxx / dn_test_xxx)."""

# ---------------------------------------------------------------------------
# Prototype pollution prevention
# ---------------------------------------------------------------------------

DANGEROUS_KEYS: FrozenSet[str] = frozenset({
    "__proto__",
    "constructor",
    "prototype",
})
"""JSON keys that must be stripped to prevent prototype pollution."""
