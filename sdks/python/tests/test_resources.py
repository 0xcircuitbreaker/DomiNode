"""One test per resource method: HTTP method, path (incl. encoding), query, body and auth mode."""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

import pytest

from conftest import ACCESS, API_KEY, Recorder, connect, new_async_client
from dominusnode import Secret

U = "123e4567-e89b-12d3-a456-426614174000"
WEIRD = "a/b c?d"
WEIRD_ENC = "a%2Fb%20c%3Fd"
KEY = API_KEY

# (name, call, method, path+query, body (None = no body), auth: "jwt" | "key" | "none", response)
CASES = [
    # auth (4)
    ("auth.verify_key", lambda c: c.auth.verify_key(KEY), "POST", "/api/auth/verify-key", {"apiKey": KEY}, "none", None),
    ("auth.refresh", lambda c: c.auth.refresh("rt"), "POST", "/api/auth/refresh", {"refreshToken": "rt"}, "none", None),
    ("auth.logout", lambda c: c.auth.logout(), "POST", "/api/auth/logout", {}, "jwt", None),
    ("auth.me", lambda c: c.auth.me(), "GET", "/api/auth/me", None, "jwt", None),
    # walletAuth (4; sign_in covered in test_signers)
    ("wallet_auth.challenge", lambda c: c.wallet_auth.challenge("0x" + "a" * 40), "POST", "/api/auth/wallet/challenge",
     {"address": "0x" + "a" * 40}, "none", None),
    ("wallet_auth.verify", lambda c: c.wallet_auth.verify("0x" + "a" * 40, "0x" + "1" * 130), "POST",
     "/api/auth/wallet/verify", {"address": "0x" + "a" * 40, "signature": "0x" + "1" * 130}, "none", None),
    ("wallet_auth.link", lambda c: c.wallet_auth.link("0x" + "a" * 40, "0x" + "1" * 130), "POST",
     "/api/auth/wallet/link", {"address": "0x" + "a" * 40, "signature": "0x" + "1" * 130}, "jwt", None),
    # keys (3)
    ("keys.create", lambda c: c.keys.create("bot"), "POST", "/api/keys", {"label": "bot"}, "jwt", {"id": "k", "key": KEY}),
    ("keys.list", lambda c: c.keys.list(), "GET", "/api/keys", None, "jwt", None),
    ("keys.revoke", lambda c: c.keys.revoke(WEIRD), "DELETE", f"/api/keys/{WEIRD_ENC}", None, "jwt", None),
    # wallet (5)
    ("wallet.get_balance", lambda c: c.wallet.get_balance(), "GET", "/api/wallet", None, "jwt", None),
    ("wallet.get_transactions", lambda c: c.wallet.get_transactions(10, 5), "GET",
     "/api/wallet/transactions?limit=10&offset=5", None, "jwt", None),
    ("wallet.get_forecast", lambda c: c.wallet.get_forecast(), "GET", "/api/wallet/forecast", None, "jwt", None),
    ("wallet.top_up_crypto", lambda c: c.wallet.top_up_crypto(1050, "BTC"), "POST", "/api/wallet/topup/crypto",
     {"amountUsd": 10.5, "currency": "btc"}, "jwt", None),
    ("wallet.get_crypto_status", lambda c: c.wallet.get_crypto_status(U), "GET", f"/api/wallet/crypto/status/{U}",
     None, "jwt", None),
    # agenticWallets (9)
    ("agentic.create", lambda c: c.agentic_wallets.create("w", 500, 100, ["a.com"]), "POST", "/api/agent-wallet",
     {"label": "w", "spendingLimitCents": 500, "dailyLimitCents": 100, "allowedDomains": ["a.com"]}, "jwt", None),
    ("agentic.list", lambda c: c.agentic_wallets.list(), "GET", "/api/agent-wallet", None, "jwt", None),
    ("agentic.get", lambda c: c.agentic_wallets.get(WEIRD), "GET", f"/api/agent-wallet/{WEIRD_ENC}", None, "jwt", None),
    ("agentic.fund", lambda c: c.agentic_wallets.fund(U, 100), "POST", f"/api/agent-wallet/{U}/fund",
     {"amountCents": 100}, "jwt", None),
    ("agentic.update_wallet_policy", lambda c: c.agentic_wallets.update_wallet_policy(U, daily_limit_cents=None),
     "PATCH", f"/api/agent-wallet/{U}/policy", {"dailyLimitCents": None}, "jwt", None),
    ("agentic.transactions", lambda c: c.agentic_wallets.transactions(U, limit=3), "GET",
     f"/api/agent-wallet/{U}/transactions?limit=3", None, "jwt", None),
    ("agentic.freeze", lambda c: c.agentic_wallets.freeze(U), "POST", f"/api/agent-wallet/{U}/freeze", {}, "jwt", None),
    ("agentic.unfreeze", lambda c: c.agentic_wallets.unfreeze(U), "POST", f"/api/agent-wallet/{U}/unfreeze", {}, "jwt", None),
    ("agentic.delete", lambda c: c.agentic_wallets.delete(U), "DELETE", f"/api/agent-wallet/{U}", None, "jwt", None),
    # teams (18)
    ("teams.create", lambda c: c.teams.create("t", 5), "POST", "/api/teams", {"name": "t", "maxMembers": 5}, "jwt", None),
    ("teams.list", lambda c: c.teams.list(), "GET", "/api/teams", None, "jwt", None),
    ("teams.get", lambda c: c.teams.get(WEIRD), "GET", f"/api/teams/{WEIRD_ENC}", None, "jwt", None),
    ("teams.update", lambda c: c.teams.update(U, name="n"), "PATCH", f"/api/teams/{U}", {"name": "n"}, "jwt", None),
    ("teams.delete", lambda c: c.teams.delete(U), "DELETE", f"/api/teams/{U}", None, "jwt", None),
    ("teams.fund_wallet", lambda c: c.teams.fund_wallet(U, 7), "POST", f"/api/teams/{U}/wallet/fund",
     {"amountCents": 7}, "jwt", None),
    ("teams.get_transactions", lambda c: c.teams.get_transactions(U, 1, 2), "GET",
     f"/api/teams/{U}/wallet/transactions?limit=1&offset=2", None, "jwt", None),
    ("teams.list_members", lambda c: c.teams.list_members(U), "GET", f"/api/teams/{U}/members", None, "jwt", None),
    ("teams.add_member", lambda c: c.teams.add_member(U, "a@b.c", "admin"), "POST", f"/api/teams/{U}/members",
     {"email": "a@b.c", "role": "admin"}, "jwt", None),
    ("teams.update_member_role", lambda c: c.teams.update_member_role(U, WEIRD, "member"), "PATCH",
     f"/api/teams/{U}/members/{WEIRD_ENC}", {"role": "member"}, "jwt", None),
    ("teams.remove_member", lambda c: c.teams.remove_member(U, U), "DELETE", f"/api/teams/{U}/members/{U}", None, "jwt", None),
    ("teams.create_invite", lambda c: c.teams.create_invite(U, "a@b.c"), "POST", f"/api/teams/{U}/invites",
     {"email": "a@b.c"}, "jwt", None),
    ("teams.list_invites", lambda c: c.teams.list_invites(U), "GET", f"/api/teams/{U}/invites", None, "jwt", None),
    ("teams.cancel_invite", lambda c: c.teams.cancel_invite(U, U), "DELETE", f"/api/teams/{U}/invites/{U}", None, "jwt", None),
    ("teams.accept_invite", lambda c: c.teams.accept_invite(WEIRD), "POST", f"/api/teams/invites/{WEIRD_ENC}/accept",
     {}, "jwt", None),
    ("teams.create_key", lambda c: c.teams.create_key(U, "ci"), "POST", f"/api/teams/{U}/keys", {"label": "ci"}, "jwt",
     {"id": "k", "keyPrefix": "dn_live_", "key": KEY}),
    ("teams.list_keys", lambda c: c.teams.list_keys(U), "GET", f"/api/teams/{U}/keys", None, "jwt", None),
    ("teams.revoke_key", lambda c: c.teams.revoke_key(U, U), "DELETE", f"/api/teams/{U}/keys/{U}", None, "jwt", None),
    # usage (4)
    ("usage.get", lambda c: c.usage.get(from_="2026-01-01", to="2026-02-01", limit=5, offset=0), "GET",
     "/api/usage?since=2026-01-01&until=2026-02-01&limit=5&offset=0", None, "jwt", None),
    ("usage.get_daily", lambda c: c.usage.get_daily(from_="2026-01-01"), "GET", "/api/usage/daily?since=2026-01-01",
     None, "jwt", None),
    ("usage.get_top_hosts", lambda c: c.usage.get_top_hosts(limit=3), "GET", "/api/usage/top-hosts?limit=3", None, "jwt", None),
    ("usage.export_csv", lambda c: c.usage.export_csv(), "GET", "/api/usage/export", None, "jwt", None),
    # sessions (2)
    ("sessions.get_active", lambda c: c.sessions.get_active(), "GET", "/api/sessions/active", None, "jwt", None),
    ("sessions.report", lambda c: c.sessions.report(U, "captcha"), "POST", f"/v1/sessions/{U}/report",
     {"reason": "captcha"}, "key", None),
    # x402 (1)
    ("x402.get_info", lambda c: c.x402.get_info(), "GET", "/api/x402/info", None, "none", None),
    # network (3)
    ("network.policy", lambda c: c.network.policy(), "GET", "/v1/policy", None, "none", None),
    ("network.pricing", lambda c: c.network.pricing(), "GET", "/v1/pricing", None, "none", None),
    ("network.stats", lambda c: c.network.stats(), "GET", "/v1/network/stats", None, "none", None),
    # nodes (6; register covered in test_signers)
    ("nodes.register_challenge", lambda c: c.nodes.register_challenge("AB" * 32), "POST", "/v1/nodes/challenge",
     {"nodePubkey": "ab" * 32}, "key", None),
    ("nodes.list", lambda c: c.nodes.list(limit=500, offset=0), "GET", "/v1/nodes?limit=500&offset=0", None, "key", None),
    ("nodes.revoke", lambda c: c.nodes.revoke(U), "DELETE", f"/v1/nodes/{U}", None, "key", None),
    ("nodes.update_caps", lambda c: c.nodes.update_caps(U, max_streams=4, req_per_sec=2), "PATCH", f"/v1/nodes/{U}",
     {"maxStreams": 4, "reqPerSec": 2}, "key", None),
    ("nodes.tier", lambda c: c.nodes.tier(), "GET", "/v1/node/tier", None, "key", None),
    # credits (4; withdraw covered in test_signers)
    ("credits.balance", lambda c: c.credits.balance(), "GET", "/v1/credits", None, "key", None),
    ("credits.transactions", lambda c: c.credits.transactions(limit=50, cursor="123", type="earn"), "GET",
     "/v1/credits/transactions?limit=50&cursor=123&type=earn", None, "key", None),
    ("credits.convert", lambda c: c.credits.convert(10_000, "idem-key-1"), "POST", "/v1/credits/convert",
     {"amountMusd": "10000"}, "key", {"converted": {"musd": "10000", "usd": "0.010000"}}),
    # payoutWallet (get; set covered in test_signers)
    ("payout_wallet.get", lambda c: c.payout_wallet.get(), "GET", "/v1/payout-wallet", None, "key", None),
    # payouts (1)
    ("payouts.list", lambda c: c.payouts.list(limit=200, offset=10), "GET", "/v1/payouts?limit=200&offset=10", None, "key", None),
    # proxy (network methods)
    ("proxy.get_health", lambda c: c.proxy.get_health(), "GET", "/api/proxy/health", None, "none", None),
    ("proxy.get_config", lambda c: c.proxy.get_config(), "GET", "/api/proxy/config", None, "jwt", None),
]


def _check(rec: Recorder, method: str, path: str, body: Any, auth: str) -> None:
    assert len(rec.requests) == 1
    r = rec.last
    assert r.method == method
    assert r.url.raw_path.decode() == path
    if body is None:
        assert r.content == b""
        assert "content-type" not in r.headers
    else:
        assert json.loads(r.content) == body
        assert r.headers["content-type"] == "application/json"
    expected = {"jwt": f"Bearer {ACCESS}", "key": f"Bearer {API_KEY}", "none": None}[auth]
    assert r.headers.get("authorization") == expected
    assert r.headers["user-agent"] == "dominusnode-sdk-python/2.0.0"
    assert r.headers["accept"] == "application/json"


@pytest.mark.parametrize("name,call,method,path,body,auth,resp", CASES, ids=[c[0] for c in CASES])
def test_sync_method(rec: Recorder, client: Any, name: str, call: Callable[[Any], Any], method: str, path: str,
                     body: Any, auth: str, resp: Optional[dict]) -> None:
    rec.add(200, resp if resp is not None else {"ok": True})
    call(client)
    _check(rec, method, path, body, auth)


@pytest.mark.parametrize("name,call,method,path,body,auth,resp", CASES, ids=[c[0] for c in CASES])
async def test_async_method(rec: Recorder, name: str, call: Callable[[Any], Any], method: str, path: str,
                            body: Any, auth: str, resp: Optional[dict]) -> None:
    c = new_async_client(rec)
    rec.add(200, {"token": ACCESS, "refreshToken": ACCESS, "userId": "u1"})
    await c.connect_with_key(API_KEY)
    rec.requests.clear()
    rec.add(200, resp if resp is not None else {"ok": True})
    await call(c)
    _check(rec, method, path, body, auth)


def test_keys_create_wraps_secret(rec: Recorder, client: Any) -> None:
    rec.add(200, {"id": "k", "prefix": "dn_live_", "label": "x", "created_at": "t", "key": API_KEY})
    r = client.keys.create("x")
    assert isinstance(r["key"], Secret) and r["key"].reveal() == API_KEY


def test_convert_sends_idempotency_header_and_echoes_key(rec: Recorder, client: Any) -> None:
    rec.add(200, {"duplicate": False})
    r = client.credits.convert("10000", idempotency_key="my-key-123")
    assert rec.last.headers["idempotency-key"] == "my-key-123"
    assert r["idempotencyKey"] == "my-key-123"
    r = client.credits.convert(10_000)
    assert r["idempotencyKey"].startswith("dn-") and rec.last.headers["idempotency-key"] == r["idempotencyKey"]


def test_top_up_whole_dollars_serialises_as_integer(rec: Recorder, client: Any) -> None:
    client.wallet.top_up_crypto(1000, "eth")
    assert rec.last.content == b'{"amountUsd": 10, "currency": "eth"}'


def test_register_challenge_without_pubkey_sends_empty_object(rec: Recorder, client: Any) -> None:
    client.nodes.register_challenge()
    assert rec.body() == {}


def test_export_csv_returns_raw_text(rec: Recorder, client: Any) -> None:
    rec.add(200, raw=b"date,bytes\n2026-01-01,5\n")
    assert client.usage.export_csv() == "date,bytes\n2026-01-01,5\n"


def test_get_active_drops_unknown_fields(rec: Recorder, client: Any) -> None:
    rec.add(200, {"sessions": [{"id": "s", "startedAt": "t", "status": "active", "proxyIp": "1.2.3.4", "nodeIp": "x"}]})
    assert client.sessions.get_active() == {"sessions": [{"id": "s", "startedAt": "t", "status": "active"}]}


def test_agent_routes_fall_back_to_wallet_jwt(rec: Recorder) -> None:
    from conftest import new_client

    c = new_client(rec, access_token=ACCESS)
    c.credits.balance()
    assert rec.last.headers["authorization"] == f"Bearer {ACCESS}"


def test_wallet_verify_stores_tokens_unless_mfa(rec: Recorder) -> None:
    from conftest import new_client

    c = new_client(rec)
    rec.add(200, {"mfaRequired": True, "mfaChallengeToken": "m"})
    r = c.wallet_auth.verify("0x" + "a" * 40, "0x" + "1" * 130)
    assert r == {"mfaRequired": True, "mfaChallengeToken": "m"} and not c.is_connected
    rec.add(200, {"token": ACCESS, "refreshToken": ACCESS, "user": {}})
    c.wallet_auth.verify("0x" + "a" * 40, "0x" + "1" * 130)
    assert c.is_connected


def test_method_count_is_71() -> None:
    from conftest import new_client

    c = new_client(Recorder())
    names = "auth wallet_auth keys wallet agentic_wallets teams usage sessions x402 network nodes credits " \
            "payout_wallet payouts proxy".split()
    total = 0
    for n in names:
        core = type(getattr(c, n)).__mro__[1]
        total += len([m for m in vars(core) if not m.startswith("_") and m != "set_lookup"])
    assert len(names) == 15 and total == 71
    for member in ("connect_with_key", "disconnect", "is_connected"):
        assert hasattr(c, member)
    for removed in ("plans", "slots", "admin", "connect_with_credentials", "complete_mfa"):
        assert not hasattr(c, removed)
