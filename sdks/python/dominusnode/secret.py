"""Secret wrapper for credentials the server returns exactly once."""

from __future__ import annotations

REDACTED = "[REDACTED]"


class Secret:
    """Wraps a credential (new API key, team key, ``dn_node_`` key).

    ``str()``, ``repr()``, ``format()`` and JSON serialisation (via ``__json__``/``to_json``)
    yield ``[REDACTED]``; call :meth:`reveal` for the value. The value lives in a
    name-mangled slot so ``vars()``/``__dict__`` do not expose it.
    """

    __slots__ = ("__value",)

    def __init__(self, value: str) -> None:
        self.__value = value

    def reveal(self) -> str:
        return self.__value

    @property
    def prefix(self) -> str:
        """First 8 characters, safe for logs."""
        return self.__value[:8]

    def __str__(self) -> str:
        return REDACTED

    def __repr__(self) -> str:
        return f"Secret({REDACTED})"

    def __format__(self, spec: str) -> str:
        return format(REDACTED, spec)

    def to_json(self) -> str:
        return REDACTED

    __json__ = to_json

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Secret) and other.__value == self.__value

    def __hash__(self) -> int:
        return hash(("Secret", self.__value))

    def __reduce__(self) -> object:
        raise TypeError("Secret cannot be pickled")


def json_default(obj: object) -> object:
    """``json.dumps(..., default=json_default)`` serialises Secret as ``[REDACTED]``."""
    if isinstance(obj, Secret):
        return REDACTED
    to_json = getattr(obj, "to_json", None)
    if callable(to_json):
        return to_json()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
