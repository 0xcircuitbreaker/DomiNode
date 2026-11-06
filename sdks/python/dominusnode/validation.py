"""Client-side argument validation. Failures raise ValidationError(code=INVALID_ARGUMENT) before any request."""

from __future__ import annotations

import re
import uuid
from typing import Any, Mapping, Optional, Union
from urllib.parse import quote, urlencode

from .constants import MAX_AMOUNT_CENTS
from .errors import invalid_arg

ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}\Z")
EIP191_SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}\Z")
MAX_SIGNATURE_LENGTH = 200
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z", re.IGNORECASE)
HEX64_RE = re.compile(r"^[0-9a-f]{64}\Z")
IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,120}\Z")
API_KEY_RE = re.compile(r"^dn_(live|test)_[A-Za-z0-9_-]{8,200}\Z")
_MUSD_RE = re.compile(r"^[1-9][0-9]{0,15}\Z")

MusdInput = Union[int, str]


def _is_int(v: Any) -> bool:
    # bool is an int subclass; floats (incl. NaN/Infinity) are never accepted.
    return isinstance(v, int) and not isinstance(v, bool)


def validate_api_key(api_key: Any) -> str:
    if not isinstance(api_key, str) or not API_KEY_RE.match(api_key):
        raise invalid_arg("api_key must be a dn_live_ or dn_test_ key")
    return api_key


def validate_address(address: Any, name: str = "address") -> str:
    if not isinstance(address, str) or not ETH_ADDRESS_RE.match(address):
        raise invalid_arg(f"{name} must be an Ethereum address (0x followed by 40 hex characters)")
    return address


def validate_signature(signature: Any, name: str = "signature") -> str:
    if not isinstance(signature, str):
        raise invalid_arg(f"{name} must be a string")
    if len(signature) > MAX_SIGNATURE_LENGTH:
        raise invalid_arg(f"{name} must not exceed {MAX_SIGNATURE_LENGTH} characters")
    if not EIP191_SIGNATURE_RE.match(signature):
        raise invalid_arg(f"{name} must be an EIP-191 signature (0x followed by 130 hex characters)")
    return signature


def validate_cents(amount_cents: Any, name: str = "amount_cents", allow_zero: bool = False) -> int:
    ok = _is_int(amount_cents) and (amount_cents >= 0 if allow_zero else amount_cents > 0) and amount_cents <= MAX_AMOUNT_CENTS
    if not ok:
        raise invalid_arg(f"{name} must be an integer {'>= 0' if allow_zero else '> 0'} and <= {MAX_AMOUNT_CENTS}")
    return int(amount_cents)


def to_musd(v: Any, minimum: int, maximum: int, name: str = "amount_musd") -> str:
    """Normalise a µUSD amount (int or digit string) to its canonical decimal string; enforce [minimum, maximum]."""
    if _is_int(v):
        n = int(v)
    elif isinstance(v, str) and _MUSD_RE.match(v):
        n = int(v)
    else:
        raise invalid_arg(f"{name} must be a positive integer number of µUSD (int or digit string)")
    if n < minimum or n > maximum:
        raise invalid_arg(f"{name} must be between {minimum} and {maximum} µUSD")
    return str(n)


def new_idempotency_key() -> str:
    """``"dn-" + UUIDv4`` (fits [A-Za-z0-9_-]{8,120})."""
    return f"dn-{uuid.uuid4()}"


def validate_idempotency_key(key: Any) -> str:
    if not isinstance(key, str) or not IDEMPOTENCY_KEY_RE.match(key):
        raise invalid_arg("idempotency_key must be 8-120 characters of [A-Za-z0-9_-]")
    return key


def validate_uuid(v: Any, name: str) -> str:
    if not isinstance(v, str) or not UUID_RE.match(v):
        raise invalid_arg(f"{name} must be a UUID")
    return v


def validate_non_empty(v: Any, name: str, maximum: int = 256) -> str:
    if not isinstance(v, str) or len(v) == 0 or len(v) > maximum:
        raise invalid_arg(f"{name} must be a non-empty string (max {maximum})")
    return v


def validate_int_range(v: Any, name: str, minimum: int, maximum: int) -> int:
    if not _is_int(v) or v < minimum or v > maximum:
        raise invalid_arg(f"{name} must be an integer in [{minimum}, {maximum}]")
    return int(v)


def validate_optional_int(v: Any, name: str) -> Optional[int]:
    """Pagination values passed through to the server: integers only (no floats/NaN)."""
    if v is None:
        return None
    if not _is_int(v):
        raise invalid_arg(f"{name} must be an integer")
    return int(v)


def seg(v: str) -> str:
    """Path segment encoder (encodeURIComponent semantics) for every user-supplied path parameter."""
    return quote(str(v), safe="-_.!~*'()")


def qs(params: Mapping[str, Any]) -> str:
    items = [(k, str(v)) for k, v in params.items() if v is not None]
    return f"?{urlencode(items)}" if items else ""
