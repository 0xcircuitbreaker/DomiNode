"""Dominus Node Dify integration -- 26 tools for the Dify AI platform.

Provides a Dify-compatible tool provider that exposes 26 tools for
interacting with the Dominus Node rotating proxy-as-a-service platform.

Tools cover:
  - Proxied HTTP fetching through rotating proxies
  - Wallet balance and usage monitoring
  - Proxy configuration and session listing
  - Agentic wallet management (create, fund, freeze, unfreeze, delete)
  - Team management (create, list, fund, keys, usage, update, role changes)
  - x402 micropayment info
  - PayPal, Stripe, and crypto top-up

Security:
  - Full SSRF prevention (private IP blocking, DNS rebinding, Teredo/6to4,
    IPv4-mapped/compatible IPv6, hex/octal/decimal normalization, zone ID
    stripping, .localhost/.local/.internal/.arpa TLD blocking, embedded
    credential blocking)
  - OFAC sanctioned country validation (CU, IR, KP, RU, SY)
  - Credential scrubbing in all error outputs
  - Prototype pollution prevention on all parsed JSON
  - HTTP method restriction (GET/HEAD/OPTIONS only for proxied fetch)
  - 10 MB response cap, 4000 char truncation, 30 s timeout
  - Redirect following disabled to prevent open redirect abuse

Requires: httpx (``pip install httpx``)
"""

from __future__ import annotations

__version__ = "1.0.0"

from dominusnode_dify.tools import (
    BLOCKED_HOSTNAMES,
    SANCTIONED_COUNTRIES,
    DominusNodeProvider,
    _extract_6to4_ipv4,
    _extract_teredo_ipv4,
    _is_private_ip,
    _normalize_ipv4,
    _sanitize_error,
    _strip_dangerous_keys,
    _validate_label,
    _validate_positive_int,
    _validate_uuid,
    validate_url,
)

__all__ = [
    "DominusNodeProvider",
    "BLOCKED_HOSTNAMES",
    "SANCTIONED_COUNTRIES",
    "_is_private_ip",
    "_normalize_ipv4",
    "_extract_teredo_ipv4",
    "_extract_6to4_ipv4",
    "_sanitize_error",
    "_strip_dangerous_keys",
    "_validate_label",
    "_validate_positive_int",
    "_validate_uuid",
    "validate_url",
]
