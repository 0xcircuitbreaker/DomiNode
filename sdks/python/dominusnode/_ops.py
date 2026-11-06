"""Sans-I/O core shared by the sync and async clients (internal).

Each resource method is written once as a generator that yields operations
(an API ``Request``, a ``Sign`` call or a blocking ``Call``) and receives their
results. ``drive_sync`` / ``drive_async`` execute those operations, so the sync
and async clients expose identical behaviour from a single implementation.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from dataclasses import dataclass
from typing import Any, Callable, Dict, Generator, Tuple, Type, TypeVar

from .errors import ProtocolError
from .http_client import AsyncHttpClient, Request, SyncHttpClient

Op = Any
Gen = Generator[Op, Any, Any]


@dataclass
class Sign:
    signer: Any
    message: str


@dataclass
class Call:
    """Blocking work (PoW, socket I/O). Sync: called inline. Async: run in a worker thread."""

    fn: Callable[..., Any]
    args: Tuple[Any, ...] = ()


def _exec_sync(http: SyncHttpClient, op: Op) -> Any:
    if isinstance(op, Request):
        return http.request(op)
    if isinstance(op, Sign):
        result = op.signer.sign_message(op.message)
        if inspect.isawaitable(result):
            if hasattr(result, "close"):
                result.close()
            raise ProtocolError("sign_message returned an awaitable; use AsyncDominusNodeClient for async signers")
        return result
    if isinstance(op, Call):
        return op.fn(*op.args)
    raise TypeError(f"unknown op {op!r}")


async def _exec_async(http: AsyncHttpClient, op: Op) -> Any:
    if isinstance(op, Request):
        return await http.request(op)
    if isinstance(op, Sign):
        result = op.signer.sign_message(op.message)
        if inspect.isawaitable(result):
            result = await result
        return result
    if isinstance(op, Call):
        return await asyncio.to_thread(op.fn, *op.args)
    raise TypeError(f"unknown op {op!r}")


def drive_sync(http: SyncHttpClient, gen: Gen) -> Any:
    value: Any = None
    exc: Any = None
    while True:
        try:
            op = gen.throw(exc) if exc is not None else gen.send(value)
        except StopIteration as stop:
            return stop.value
        try:
            value, exc = _exec_sync(http, op), None
        except Exception as e:  # noqa: BLE001 - delivered into the generator
            value, exc = None, e


async def drive_async(http: AsyncHttpClient, gen: Gen) -> Any:
    value: Any = None
    exc: Any = None
    while True:
        try:
            op = gen.throw(exc) if exc is not None else gen.send(value)
        except StopIteration as stop:
            return stop.value
        try:
            value, exc = await _exec_async(http, op), None
        except Exception as e:  # noqa: BLE001
            value, exc = None, e


T = TypeVar("T")


def _sync_method(fn: Callable[..., Gen]) -> Callable[..., Any]:
    @functools.wraps(fn)
    def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        return drive_sync(self._http, fn(self, *args, **kwargs))

    return wrapper


def _async_method(fn: Callable[..., Gen]) -> Callable[..., Any]:
    @functools.wraps(fn)
    async def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
        return await drive_async(self._http, fn(self, *args, **kwargs))

    return wrapper


def make_variants(core: Type[T]) -> Tuple[Type[T], Type[T]]:
    """Build (SyncResource, AsyncResource) subclasses: every public generator method becomes a plain/async method."""
    name = core.__name__.lstrip("_")
    sync_ns: Dict[str, Any] = {"__doc__": core.__doc__, "__module__": core.__module__}
    async_ns: Dict[str, Any] = {"__doc__": core.__doc__, "__module__": core.__module__}
    for attr, value in vars(core).items():
        if not attr.startswith("_") and inspect.isgeneratorfunction(value):
            sync_ns[attr] = _sync_method(value)
            async_ns[attr] = _async_method(value)
    return type(name, (core,), sync_ns), type("Async" + name, (core,), async_ns)  # type: ignore[return-value]
