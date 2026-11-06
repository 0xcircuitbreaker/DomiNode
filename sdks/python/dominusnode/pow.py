"""Node-registration proof of work."""

from __future__ import annotations

import hashlib

from .errors import ProtocolError


def leading_zero_bits(digest: bytes) -> int:
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        return bits + 8 - byte.bit_length()
    return bits


def solve_pow(prefix: str, difficulty: int, max_iterations: int = 200_000_000) -> str:
    """Smallest decimal n >= 0 with sha256(prefix + str(n)) having >= difficulty leading zero bits."""
    if not isinstance(prefix, str) or not (1 <= len(prefix) <= 256):
        raise ProtocolError("invalid PoW prefix")
    if not isinstance(difficulty, int) or isinstance(difficulty, bool) or not (1 <= difficulty <= 32):
        raise ProtocolError("invalid PoW difficulty")
    base = hashlib.sha256(prefix.encode("utf-8"))
    for n in range(max_iterations):
        s = str(n)
        h = base.copy()
        h.update(s.encode("ascii"))
        if leading_zero_bits(h.digest()) >= difficulty:
            return s
    raise ProtocolError("PoW not solved within iteration cap")
