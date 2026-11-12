"""2.0.1 server-alignment fixes: team keys, health, cursor, chain, retries, Content-Length, pagination."""

from __future__ import annotations

from typing import Any, List

import httpx
import pytest

from dominusnode import ConflictError, RateLimitError, ServerError, ValidationError
from dominusnode.messages import build_payout_wallet_message

from conftest import ACCESS, API_KEY, Recorder, connect, new_async_client, new_client

TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
USER = "11111111-2222-4333-8444-555555555555"
WALLET = "0x" + "1" * 40
NEW = "0x" + "3" * 40
NONCE = "f" * 64
SIG = "0x" + "ab" * 65


class _Signer:
    address = WALLET

    def sign_message(self, m: str) -> str:
        return SIG


def test_create_key_reads_prefix(rec: Recorder, client: Any) -> None:
    rec.add(201, {"id": "k", "prefix": "dn_live_ab", "label": "l", "key": API_KEY})
    r = client.teams.create_key(TEAM, "l")
    assert r["prefix"] == "dn_live_ab" and r["keyPrefix"] == "dn_live_ab"
    assert r["key"].reveal() == API_KEY


def test_create_key_falls_back_to_key_prefix(rec: Recorder, client: Any) -> None:
    rec.add(201, {"id": "k", "keyPrefix": "dn_live_cd", "label": "l", "key": API_KEY})
    assert client.teams.create_key(TEAM, "l")["prefix"] == "dn_live_cd"


def test_list_keys_exposes_fields(rec: Recorder, client: Any) -> None:
    rec.add(200, {"keys": [
        {"id": "k1", "userId": "u1", "prefix": "dn_live_x", "label": "a", "teamId": TEAM, "createdAt": "t", "revokedAt": None},
        {"id": "k2", "userId": "u2", "keyPrefix": "dn_live_y", "label": "b", "teamId": TEAM, "createdAt": "t", "revokedAt": "r"},
    ]})
    keys = client.teams.list_keys(TEAM)["keys"]
    assert keys[0]["prefix"] == "dn_live_x" and keys[0]["userId"] == "u1" and keys[0]["teamId"] == TEAM
    assert keys[0]["revokedAt"] is None
    assert keys[1]["prefix"] == "dn_live_y" and keys[1]["revokedAt"] == "r"


def test_health_status_only(rec: Recorder, client: Any) -> None:
    rec.add(200, {"status": "ok", "activeSessions": 3})
    assert client.proxy.get_health() == {"status": "ok"}


@pytest.mark.parametrize("cursor", ["0", "01", "1" * 20, "-1", "1a"])
def test_cursor_rejected(rec: Recorder, client: Any, cursor: str) -> None:
    with pytest.raises(ValidationError):
        client.credits.transactions(cursor=cursor)
    assert rec.requests == []


def test_cursor_19_digits_ok(rec: Recorder, client: Any) -> None:
    rec.add(200, {"transactions": [], "nextCursor": None})
    client.credits.transactions(cursor="9" * 19)
    assert "cursor=" + "9" * 19 in str(rec.last.url)


def test_payout_wallet_base_sepolia(rec: Recorder, client: Any) -> None:
    msg = build_payout_wallet_message(USER, WALLET, NEW, "base-sepolia", NONCE)
    rec.add(200, {"nonce": NONCE, "message": msg, "expiresAt": "t", "signer": WALLET,
                  "oldWalletSignatureRequired": False, "oldWalletAddress": None})
    rec.add(200, {"payoutWallet": None, "changed": True, "cooldownHours": 0})
    client.payout_wallet.set(NEW, _Signer(), chain="base-sepolia")
    assert rec.body(0) == {"address": NEW, "chain": "base-sepolia"}
    assert rec.body(1)["chain"] == "base-sepolia"


def test_payout_wallet_other_chain_rejected(rec: Recorder, client: Any) -> None:
    with pytest.raises(ValidationError):
        client.payout_wallet.set(NEW, _Signer(), chain="eth")
    assert rec.requests == []


def test_409_report_limit_not_retried(rec: Recorder, client: Any) -> None:
    rec.add(409, {"error": "At most 20 reports", "code": "REPORT_LIMIT"})
    with pytest.raises(ConflictError) as ei:
        client.sessions.report(TEAM, "blocked")
    assert ei.value.code == "REPORT_LIMIT"
    assert len(rec.requests) == 1


def test_429_retried_once(rec: Recorder, client: Any) -> None:
    rec.add(429, {"error": "slow"}, {"retry-after": "0"})
    rec.add(429, {"error": "slow", "code": "REPORT_LIMIT"}, {"retry-after": "0"})
    with pytest.raises(RateLimitError) as ei:
        client.sessions.report(TEAM, "blocked")
    assert ei.value.code == "REPORT_LIMIT"
    assert len(rec.requests) == 2


@pytest.mark.parametrize("value", ["abc", "-1", "1.5", "10, 10", "99999999999999999999999"])
def test_malformed_content_length(value: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": value}, stream=httpx.ByteStream(b"{}"))

    from dominusnode import DominusNodeClient

    c = DominusNodeClient(base_url="https://api.test", transport=httpx.MockTransport(handler))
    with pytest.raises(ServerError):
        c.network.policy()


def test_iter_credit_transactions(rec: Recorder, client: Any) -> None:
    rec.add(200, {"transactions": [{"id": "3"}, {"id": "2"}], "nextCursor": "2"})
    rec.add(200, {"transactions": [{"id": "1"}], "nextCursor": None})
    assert [t["id"] for t in client.credits.iter_transactions(limit=2, type="earn")] == ["3", "2", "1"]
    assert str(rec.requests[1].url).endswith("/v1/credits/transactions?limit=2&cursor=2&type=earn")


def test_offset_iterators(rec: Recorder, client: Any) -> None:
    rec.add(200, {"payouts": [{"id": "a"}, {"id": "b"}]})
    rec.add(200, {"payouts": [{"id": "c"}]})
    assert len(list(client.payouts.iterate(limit=2))) == 3
    assert str(rec.requests[1].url).endswith("/v1/payouts?limit=2&offset=2")
    rec.requests.clear()
    rec.add(200, {"nodes": [{"id": "a"}]})
    rec.add(200, {"nodes": []})
    assert len(list(client.nodes.iterate(limit=1))) == 1
    rec.requests.clear()
    rec.add(200, {"records": [{"id": "a"}, {"id": "b"}], "pagination": {"total": 2}})
    assert len(list(client.usage.iter_records(limit=2, from_="2026-01-01"))) == 2
    assert len(rec.requests) == 1
    assert str(rec.last.url).endswith("/api/usage?since=2026-01-01&limit=2&offset=0")
    rec.requests.clear()
    rec.add(200, {"transactions": [{"id": "a"}]})
    assert len(list(client.wallet.iter_transactions(limit=5))) == 1
    with pytest.raises(ValidationError):
        list(client.wallet.iter_transactions(limit=101))


async def test_async_iterators(rec: Recorder) -> None:
    c = new_async_client(rec)
    rec.add(200, {"token": ACCESS, "refreshToken": ACCESS, "userId": "u1"})
    await c.connect_with_key(API_KEY)
    rec.requests.clear()
    rec.add(200, {"transactions": [{"id": "2"}], "nextCursor": "2"})
    rec.add(200, {"transactions": [], "nextCursor": None})
    got: List[Any] = [t async for t in c.credits.iter_transactions()]
    assert [t["id"] for t in got] == ["2"]
    rec.add(200, {"nodes": [{"id": "a"}, {"id": "b"}]})
    rec.add(200, {"nodes": []})
    assert len([n async for n in c.nodes.iterate(limit=2)]) == 2
    rec.add(200, {"payouts": []})
    assert [p async for p in c.payouts.iterate()] == []


def test_sync_client_unused_helpers() -> None:
    c = new_client(Recorder())
    assert hasattr(c.wallet, "iter_transactions") and hasattr(c.usage, "iter_records")
    connect  # noqa: B018 - imported for parity with other test modules
