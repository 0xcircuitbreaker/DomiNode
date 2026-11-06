"""Client-side validation (no request sent) and credential redaction / lifecycle."""

from __future__ import annotations

import json
import pickle
from typing import Any, Callable

import pytest

from conftest import make_jwt, ACCESS, API_KEY, REFRESH, Recorder, connect, new_async_client, new_client
from dominusnode import AuthenticationError, AuthorizationError, Secret, ValidationError, json_default

U = "123e4567-e89b-12d3-a456-426614174000"
A = "0x" + "a" * 40
MAX = 2_147_483_647

INVALID: list = [
    # cents bounds
    lambda c: c.agentic_wallets.fund(U, 0),
    lambda c: c.agentic_wallets.fund(U, MAX + 1),
    lambda c: c.agentic_wallets.fund(U, 1.0),
    lambda c: c.agentic_wallets.fund(U, float("nan")),
    lambda c: c.agentic_wallets.fund(U, float("inf")),
    lambda c: c.agentic_wallets.fund(U, True),
    lambda c: c.teams.fund_wallet(U, 0),
    lambda c: c.teams.fund_wallet(U, MAX + 1),
    lambda c: c.agentic_wallets.create("w", -1),
    lambda c: c.agentic_wallets.create("w", MAX + 1),
    lambda c: c.agentic_wallets.create("w", 0, daily_limit_cents=MAX + 1),
    lambda c: c.agentic_wallets.update_wallet_policy(U, daily_limit_cents=-1),
    lambda c: c.wallet.top_up_crypto(999, "btc"),
    lambda c: c.wallet.top_up_crypto(100_001, "btc"),
    lambda c: c.wallet.top_up_crypto(0, "btc"),
    lambda c: c.wallet.top_up_crypto(1000, "doge"),
    # µUSD bounds
    lambda c: c.credits.convert(9_999),
    lambda c: c.credits.convert(10_000_000_001),
    lambda c: c.credits.convert("10000.5"),
    lambda c: c.credits.convert(1e5),
    lambda c: c.credits.convert("-10000"),
    # UUIDs
    lambda c: c.wallet.get_crypto_status("nope"),
    lambda c: c.sessions.report("nope", "captcha"),
    lambda c: c.nodes.revoke("../etc"),
    lambda c: c.nodes.update_caps("x", max_streams=1),
    # enums / ranges
    lambda c: c.sessions.report(U, "angry"),
    lambda c: c.nodes.update_caps(U),
    lambda c: c.nodes.update_caps(U, max_streams=0),
    lambda c: c.nodes.update_caps(U, gb_per_day=1_000_001),
    lambda c: c.nodes.list(limit=0),
    lambda c: c.nodes.list(limit=501),
    lambda c: c.nodes.list(offset=1_000_001),
    lambda c: c.nodes.register_challenge("12"),
    lambda c: c.credits.transactions(limit=201),
    lambda c: c.credits.transactions(cursor="abc"),
    lambda c: c.credits.transactions(type="steal"),
    lambda c: c.payouts.list(limit=0),
    lambda c: c.payouts.list(offset=-1),
    lambda c: c.wallet.get_transactions(limit=float("nan")),
    # addresses / signatures
    lambda c: c.wallet_auth.challenge("0x123"),
    lambda c: c.wallet_auth.verify("0xZZ" + "a" * 38, "0x" + "1" * 130),
    lambda c: c.wallet_auth.verify(A, "0x" + "1" * 129),
    lambda c: c.wallet_auth.verify(A, "0x" + "1" * 199),
    lambda c: c.wallet_auth.verify(A, "0x" + "g" * 130),
    lambda c: c.wallet_auth.link(A, "0x" + "1" * 131),
    # labels / keys
    lambda c: c.keys.create(""),
    lambda c: c.keys.create("x" * 101),
    lambda c: c.teams.create_key(U, ""),
    lambda c: c.keys.revoke(""),
    lambda c: c.auth.verify_key("sk_live_123456789"),
    lambda c: c.auth.verify_key("dn_live_short"),
    lambda c: c.auth.refresh(""),
]


@pytest.mark.parametrize("call", INVALID)
def test_invalid_arguments_send_nothing(rec: Recorder, client: Any, call: Callable[[Any], Any]) -> None:
    with pytest.raises(ValidationError) as ei:
        call(client)
    assert ei.value.code == "INVALID_ARGUMENT" and ei.value.status_code is None
    assert rec.requests == []


def test_valid_boundaries(rec: Recorder, client: Any) -> None:
    client.agentic_wallets.fund(U, MAX)
    client.agentic_wallets.create("w", 0)
    client.credits.convert(10_000_000_000)
    client.wallet.top_up_crypto(100_000, "USDC")
    assert rec.body(0) == {"amountCents": MAX}


# ------------------------------------------------------------ Secret
def test_secret_redaction() -> None:
    s = Secret(API_KEY)
    assert s.reveal() == API_KEY and s.prefix == API_KEY[:8]
    assert str(s) == "[REDACTED]" and repr(s) == "Secret([REDACTED])" and f"{s}" == "[REDACTED]"
    assert json.dumps({"k": s}, default=json_default) == '{"k": "[REDACTED]"}'
    assert API_KEY not in repr({"key": s})
    assert not hasattr(s, "__dict__")
    with pytest.raises(TypeError):
        pickle.dumps(s)


# ------------------------------------------------------------ client / token manager redaction + lifecycle
def test_client_and_token_manager_redaction(rec: Recorder, client: Any) -> None:
    for text in (repr(client), str(client), repr(client._ctx.tokens), str(client._ctx.tokens), repr(client._ctx),
                 json.dumps(client.to_json()), json.dumps(client._ctx.tokens.to_json()), repr(client._http)):
        assert API_KEY not in text and ACCESS not in text
    assert repr(client) == "DominusNodeClient(connected=true)"
    assert client.to_json() == {"connected": True}
    with pytest.raises(TypeError):
        pickle.dumps(client)


def test_disconnect_clears_everything(rec: Recorder, client: Any) -> None:
    assert client.is_connected
    client.disconnect()
    assert rec.last.url.path == "/api/auth/logout" and rec.last.headers["authorization"] == f"Bearer {ACCESS}"
    assert not client.is_connected
    assert client._ctx.api_key is None and client._ctx.tokens.access_token is None
    assert client._ctx.tokens.refresh_token is None
    assert repr(client) == "DominusNodeClient(connected=false)"
    with pytest.raises(AuthenticationError):
        client.proxy.build_url()


def test_disconnect_ignores_logout_failure(rec: Recorder, client: Any) -> None:
    rec.add(500, {"error": "down"})
    client.disconnect()
    assert not client.is_connected


def test_clear_keeps_refresh_function_and_reconnect_works(rec: Recorder, client: Any) -> None:
    tm = client._ctx.tokens
    client.disconnect()
    assert tm.has_refresh_function()
    connect(client, rec)
    assert client.is_connected
    tm.set_tokens(make_jwt(-10), REFRESH)  # expired -> refresh
    rec.add(200, {"token": ACCESS})
    rec.add(200, {"user": {}})
    client.auth.me()
    assert rec.requests[0].url.path == "/api/auth/refresh"


def test_connect_with_key_mfa_keeps_only_key(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(403, {"error": "MFA", "mfaRequired": True})
    assert c.connect_with_key(API_KEY) == {"mfaRequired": True}
    assert c.is_connected and c._ctx.tokens.access_token is None
    c.credits.balance()
    assert rec.last.headers["authorization"] == f"Bearer {API_KEY}"


def test_connect_with_key_other_error_stores_nothing(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(403, {"error": "suspended", "code": "ACCOUNT_FROZEN"})
    with pytest.raises(AuthorizationError):
        c.connect_with_key(API_KEY)
    assert not c.is_connected


def test_connect_with_key_validates_format(rec: Recorder) -> None:
    c = new_client(rec)
    with pytest.raises(ValidationError):
        c.connect_with_key("dn_node_" + "a" * 64)
    assert rec.requests == []


def test_connect_with_key_result(rec: Recorder) -> None:
    c = new_client(rec)
    rec.add(200, {"token": ACCESS, "refreshToken": REFRESH, "userId": "u9"})
    assert c.connect_with_key(API_KEY) == {"mfaRequired": False, "userId": "u9"}


async def test_async_disconnect(rec: Recorder) -> None:
    c = new_async_client(rec)
    rec.add(200, {"token": ACCESS, "refreshToken": REFRESH, "userId": "u"})
    await c.connect_with_key(API_KEY)
    assert repr(c) == "AsyncDominusNodeClient(connected=true)"
    await c.disconnect()
    assert not c.is_connected and c._ctx.tokens.has_refresh_function()
