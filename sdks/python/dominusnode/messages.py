"""Byte-exact builders for every message the SDK asks a signer to sign.

The SDK never signs a server string blindly: it rebuilds the message from values
it knows and refuses (ProtocolError) if the server's text differs.
Server sources: packages/shared/src/attestation.ts, packages/dashboard/src/routes/v1/credits.ts.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from .errors import ProtocolError
from .validation import UUID_RE


def build_attestation_message(
    wallet: str, nonce: str, attestation_version: int, attestation_text: str, node_pubkey: Optional[str]
) -> str:
    return "\n".join(
        [
            "DomiNode node attestation",
            f"Version: {attestation_version}",
            f"Wallet: {wallet.lower()}",
            f"Nonce: {nonce}",
            f"Node pubkey: {node_pubkey if node_pubkey is not None else 'none'}",
            "",
            attestation_text,
        ]
    )


def build_payout_wallet_message(user_id: str, wallet: str, address: str, chain: str, nonce: str) -> str:
    return "\n".join(
        [
            "DominusNode payout wallet",
            "Action: payout_wallet_set",
            f"User: {user_id}",
            f"Account wallet: {wallet.lower()}",
            f"Payout address: {address.lower()}",
            f"Chain: {chain}",
            f"Nonce: {nonce}",
        ]
    )


def build_withdraw_message(user_id: str, wallet: str, amount_musd: str, idempotency_key: str, nonce: str) -> str:
    return "\n".join(
        [
            "DominusNode withdrawal",
            "Action: withdraw",
            f"User: {user_id}",
            f"Account wallet: {wallet.lower()}",
            f"Amount (µUSD): {amount_musd}",
            f"Idempotency key: {idempotency_key}",
            f"Nonce: {nonce}",
        ]
    )


def build_convert_message(user_id: str, wallet: str, amount_musd: str, idempotency_key: str, nonce: str) -> str:
    return "\n".join(
        [
            "DominusNode credit conversion",
            "Action: convert",
            f"User: {user_id}",
            f"Account wallet: {wallet.lower()}",
            f"Amount (µUSD): {amount_musd}",
            f"Idempotency key: {idempotency_key}",
            f"Nonce: {nonce}",
        ]
    )


_USER_LINE = re.compile(r"^User: (.+)\Z")


def extract_user_id(message: str) -> str:
    """Take the user id from line 3 (``User: <uuid>``); it must be a UUID."""
    lines = message.split("\n")
    line = lines[2] if len(lines) > 2 else ""
    m = _USER_LINE.match(line)
    if not m or not UUID_RE.match(m.group(1)):
        raise ProtocolError("challenge message has no valid User line")
    return m.group(1)


def assert_same_message(server: Any, local: str, what: str) -> None:
    if not isinstance(server, str) or server != local:
        raise ProtocolError(
            f"{what}: the server's message differs from the one built locally; refusing to sign "
            "(wrong signer for the linked wallet, mismatched parameters, or protocol change)"
        )
