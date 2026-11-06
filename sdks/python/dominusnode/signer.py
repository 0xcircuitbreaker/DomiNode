"""Caller-supplied EIP-191 signer callback.

The SDK has no crypto dependency. Wrap eth-account, web3.py, a KMS or an HSM::

    from eth_account import Account
    from eth_account.messages import encode_defunct

    acct = Account.from_key(pk)

    class MySigner:
        address = acct.address
        def sign_message(self, message: str) -> str:
            return "0x" + acct.sign_message(encode_defunct(text=message)).signature.hex().removeprefix("0x")

``sign_message`` MUST perform ``personal_sign`` over the exact UTF-8 string and return a
65-byte 0x-hex signature. With ``AsyncDominusNodeClient`` it may be ``async def``.
"""

from __future__ import annotations

from typing import Any, Awaitable, Generator, Union

try:  # Python 3.8+
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    from typing_extensions import Protocol, runtime_checkable  # type: ignore

from ._ops import Sign
from .errors import ProtocolError, ValidationError, invalid_arg
from .validation import validate_address, validate_signature


@runtime_checkable
class Signer(Protocol):
    address: str

    def sign_message(self, message: str) -> Union[str, Awaitable[str]]: ...


def assert_signer(signer: Any, name: str = "signer") -> Any:
    if signer is None or not callable(getattr(signer, "sign_message", None)):
        raise invalid_arg(f"{name} must have an address and a sign_message(message) method")
    validate_address(getattr(signer, "address", None), f"{name}.address")
    return signer


def sign(signer: Any, message: str, name: str = "signer") -> Generator[Any, Any, str]:
    """Ask the signer for a signature (as an op) and validate its format; failures raise ProtocolError."""
    try:
        sig = yield Sign(signer, message)
    except Exception as err:  # noqa: BLE001
        raise ProtocolError(f"{name}.sign_message failed: {err}") from None
    try:
        return validate_signature(sig, f"{name} signature")
    except ValidationError as err:
        raise ProtocolError(err.message) from None
