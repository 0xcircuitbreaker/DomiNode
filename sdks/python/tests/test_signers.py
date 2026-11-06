"""Signed flows: byte-for-byte message parity, node register, withdraw, payout wallet, refusals."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, List

import pytest

from conftest import API_KEY, Recorder, new_async_client
from dominusnode import (
    ProtocolError,
    Secret,
    ValidationError,
    build_attestation_message,
    build_payout_wallet_message,
    build_withdraw_message,
)
from dominusnode.pow import leading_zero_bits, solve_pow

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "signed_messages.json").read_text(encoding="utf-8"))
ADDR = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"
OLD = "0x" + "1" * 40
USER = "123e4567-e89b-12d3-a456-426614174000"
SIG = "0x" + "ab" * 65
NONCE = "c" * 64
CH_ID = "00000000-0000-4000-8000-000000000001"


class FakeSigner:
    def __init__(self, address: str = ADDR, sig: Any = SIG, fail: bool = False) -> None:
        self.address = address
        self.sig = sig
        self.fail = fail
        self.messages: List[str] = []

    def sign_message(self, message: str) -> Any:
        self.messages.append(message)
        if self.fail:
            raise RuntimeError(f"hsm offline {API_KEY}")
        return self.sig


# ------------------------------------------------------------ byte-for-byte parity with the Node builders
@pytest.mark.parametrize("case", FIXTURES["attestation"])
def test_attestation_matches_node(case: Any) -> None:
    p = case["params"]
    got = build_attestation_message(p["wallet"], p["nonce"], p["attestationVersion"], p["attestationText"], p["nodePubkey"])
    assert got.encode("utf-8") == case["message"].encode("utf-8")


@pytest.mark.parametrize("case", FIXTURES["payoutWallet"])
def test_payout_wallet_message_matches_node(case: Any) -> None:
    p = case["params"]
    got = build_payout_wallet_message(p["userId"], p["wallet"], p["address"], p["chain"], p["nonce"])
    assert got.encode("utf-8") == case["message"].encode("utf-8")


@pytest.mark.parametrize("case", FIXTURES["withdraw"])
def test_withdraw_message_matches_node(case: Any) -> None:
    p = case["params"]
    got = build_withdraw_message(p["userId"], p["wallet"], p["amountMusd"], p["idempotencyKey"], p["nonce"])
    assert got.encode("utf-8") == case["message"].encode("utf-8")


def test_messages_have_no_trailing_newline() -> None:
    for group in FIXTURES.values():
        for case in group:
            assert not case["message"].endswith("\n")


# ------------------------------------------------------------ node register
def node_challenge(pubkey: Any = None, **over: Any) -> dict:
    ch = {
        "nonce": NONCE,
        "attestationText": "I run a relay node.\nTerms v1",
        "attestationVersion": 2,
        "policyVersion": 1,
        "expiresAt": "t",
        "powChallenge": {"challengeId": CH_ID, "prefix": "pfx", "difficulty": 8, "algorithm": "sha256", "expiresAt": "t"},
    }
    ch["message"] = build_attestation_message(ADDR, NONCE, 2, ch["attestationText"], pubkey)
    ch.update(over)
    return ch


NODE_KEY = "dn_node_" + "f" * 64


def test_register_full_flow(rec: Recorder, client: Any) -> None:
    pk = "AB" * 32
    rec.add(200, node_challenge("ab" * 32))
    rec.add(200, {"nodeId": CH_ID, "nodeKey": NODE_KEY, "status": "active", "attestationVersion": 2})
    s = FakeSigner()
    r = client.nodes.register(s, node_pubkey=pk, max_streams=8, max_gb_day=5)
    assert rec.body(0) == {"nodePubkey": "ab" * 32}
    body = rec.body(1)
    assert rec.requests[1].url.path == "/v1/nodes"
    assert rec.requests[1].headers["authorization"] == f"Bearer {API_KEY}"
    n = body["pow"]["nonce"]
    assert leading_zero_bits(hashlib.sha256(("pfx" + n).encode()).digest()) >= 8
    assert n == solve_pow("pfx", 8)
    assert body == {"nonce": NONCE, "walletSignature": SIG, "attestationVersion": 2,
                    "pow": {"challengeId": CH_ID, "nonce": n}, "nodePubkey": "ab" * 32, "maxStreams": 8, "maxGbDay": 5}
    assert s.messages == [node_challenge("ab" * 32)["message"]]
    assert isinstance(r["nodeKey"], Secret) and r["nodeKey"].reveal() == NODE_KEY
    assert "dn_node_" not in repr(r)


def test_register_with_supplied_challenge_skips_request(rec: Recorder, client: Any) -> None:
    rec.add(200, {"nodeId": CH_ID, "nodeKey": NODE_KEY, "status": "pending", "attestationVersion": 2})
    client.nodes.register(FakeSigner(), challenge=node_challenge())
    assert len(rec.requests) == 1 and "nodePubkey" not in rec.body(0)


def test_pow_is_smallest_solution() -> None:
    n = int(solve_pow("abc", 6))
    for i in range(n):
        assert leading_zero_bits(hashlib.sha256(f"abc{i}".encode()).digest()) < 6


@pytest.mark.parametrize("prefix,diff", [("", 4), ("x" * 257, 4), ("p", 0), ("p", 33)])
def test_pow_refuses_bad_parameters(prefix: str, diff: int) -> None:
    with pytest.raises(ProtocolError):
        solve_pow(prefix, diff)


def test_pow_iteration_cap(rec: Recorder, client: Any) -> None:
    rec.add(200, node_challenge(powChallenge={"challengeId": CH_ID, "prefix": "p", "difficulty": 32}))
    s = FakeSigner()
    with pytest.raises(ProtocolError, match="iteration cap"):
        client.nodes.register(s, max_pow_iterations=10)
    assert s.messages == []


def test_register_message_mismatch_refused(rec: Recorder, client: Any) -> None:
    s = FakeSigner()
    bad = node_challenge()
    bad["message"] = bad["message"].replace("Terms v1", "Terms v2")
    rec.add(200, bad)
    with pytest.raises(ProtocolError, match="differs"):
        client.nodes.register(s)
    assert s.messages == [] and len(rec.requests) == 1


def test_register_wrong_wallet_refused(rec: Recorder, client: Any) -> None:
    s = FakeSigner(address=OLD)
    rec.add(200, node_challenge())
    with pytest.raises(ProtocolError):
        client.nodes.register(s)
    assert s.messages == []


@pytest.mark.parametrize("over", [
    {"nonce": "XYZ"}, {"attestationText": ""}, {"attestationText": "x" * (64 * 1024 + 1)},
    {"attestationVersion": 0}, {"attestationVersion": 100001}, {"attestationVersion": True},
    {"powChallenge": {"challengeId": "nope", "prefix": "p", "difficulty": 4}},
    {"powChallenge": {"challengeId": CH_ID, "prefix": 1, "difficulty": 4}},
])
def test_register_bad_challenge_refused(rec: Recorder, client: Any, over: dict) -> None:
    s = FakeSigner()
    rec.add(200, node_challenge(**over))
    with pytest.raises(ProtocolError):
        client.nodes.register(s)
    assert s.messages == []


@pytest.mark.parametrize("resp", [
    {"nodeId": "x", "nodeKey": NODE_KEY}, {"nodeId": CH_ID, "nodeKey": "dn_node_short"},
    {"nodeId": CH_ID, "nodeKey": API_KEY},
])
def test_register_bad_response_refused(rec: Recorder, client: Any, resp: dict) -> None:
    rec.add(200, node_challenge())
    rec.add(200, resp)
    with pytest.raises(ProtocolError):
        client.nodes.register(FakeSigner())


@pytest.mark.parametrize("kw", [{"max_streams": 0}, {"max_streams": 1025}, {"max_gb_day": 10001},
                                {"node_pubkey": "zz"}, {"max_streams": 2.0}])
def test_register_validation_before_request(rec: Recorder, client: Any, kw: dict) -> None:
    with pytest.raises(ValidationError):
        client.nodes.register(FakeSigner(), **kw)
    assert rec.requests == []


# ------------------------------------------------------------ withdraw
def withdraw_challenge(amount: str, key: str, **over: Any) -> dict:
    ch = {"nonce": NONCE, "expiresAt": "t", "signer": ADDR.lower(),
          "message": build_withdraw_message(USER, ADDR, amount, key, NONCE)}
    ch.update(over)
    return ch


def test_withdraw_flow(rec: Recorder, client: Any) -> None:
    rec.add(200, withdraw_challenge("1000000", "idem-12345"))
    rec.add(200, {"payout": {"id": "p", "status": "pending"}, "duplicate": False})
    s = FakeSigner()
    r = client.credits.withdraw(1_000_000, s, idempotency_key="idem-12345")
    assert rec.requests[0].url.path == "/v1/credits/withdraw/challenge"
    assert rec.body(0) == {"amountMusd": "1000000", "idempotencyKey": "idem-12345"}
    assert rec.body(1) == {"amountMusd": "1000000", "idempotencyKey": "idem-12345", "nonce": NONCE, "signature": SIG}
    assert s.messages == [build_withdraw_message(USER, ADDR, "1000000", "idem-12345", NONCE)]
    assert r["idempotencyKey"] == "idem-12345" and r["duplicate"] is False


def test_withdraw_default_key(rec: Recorder, client: Any) -> None:
    s = FakeSigner()
    rec.add(200, {"nonce": NONCE, "signer": ADDR, "message": "x"})
    with pytest.raises(ProtocolError):
        client.credits.withdraw("2000000", s)
    key = rec.body(0)["idempotencyKey"]
    assert key.startswith("dn-") and len(key) == 39 and s.messages == []


@pytest.mark.parametrize("mutate", [
    lambda m: m.replace("Amount (µUSD): 1000000", "Amount (µUSD): 9000000"),
    lambda m: m.replace("withdrawal", "withdrawal!"),
    lambda m: m + "\n",
    lambda m: m.replace(USER, "not-a-uuid"),
])
def test_withdraw_message_mismatch_refused(rec: Recorder, client: Any, mutate: Any) -> None:
    ch = withdraw_challenge("1000000", "idem-12345")
    ch["message"] = mutate(ch["message"])
    rec.add(200, ch)
    s = FakeSigner()
    with pytest.raises(ProtocolError):
        client.credits.withdraw(1_000_000, s, idempotency_key="idem-12345")
    assert s.messages == [] and len(rec.requests) == 1


def test_withdraw_server_signer_mismatch(rec: Recorder, client: Any) -> None:
    rec.add(200, withdraw_challenge("1000000", "idem-12345", signer=OLD))
    s = FakeSigner()
    with pytest.raises(ProtocolError, match="linked wallet"):
        client.credits.withdraw(1_000_000, s, idempotency_key="idem-12345")
    assert s.messages == []


@pytest.mark.parametrize("sig", ["0x" + "a" * 129, "0x" + "a" * 199, "0x" + "g" * 130, None, 5])
def test_bad_signature_from_signer(rec: Recorder, client: Any, sig: Any) -> None:
    rec.add(200, withdraw_challenge("1000000", "idem-12345"))
    with pytest.raises(ProtocolError):
        client.credits.withdraw(1_000_000, FakeSigner(sig=sig), idempotency_key="idem-12345")
    assert len(rec.requests) == 1


def test_signer_exception_is_protocol_error_and_scrubbed(rec: Recorder, client: Any) -> None:
    rec.add(200, withdraw_challenge("1000000", "idem-12345"))
    with pytest.raises(ProtocolError) as ei:
        client.credits.withdraw(1_000_000, FakeSigner(fail=True), idempotency_key="idem-12345")
    assert API_KEY not in str(ei.value) and "[REDACTED]" in str(ei.value)


@pytest.mark.parametrize("amount", [999_999, 100_000_000_001, "0", "01000000", 1.5e6, float("nan"), True, "1e6"])
def test_withdraw_amount_bounds(rec: Recorder, client: Any, amount: Any) -> None:
    with pytest.raises(ValidationError):
        client.credits.withdraw(amount, FakeSigner())
    assert rec.requests == []


@pytest.mark.parametrize("key", ["short", "x" * 121, "has space1", "ünïcode12"])
def test_idempotency_key_validation(rec: Recorder, client: Any, key: str) -> None:
    with pytest.raises(ValidationError):
        client.credits.withdraw(1_000_000, FakeSigner(), idempotency_key=key)
    with pytest.raises(ValidationError):
        client.credits.convert(10_000, idempotency_key=key)
    assert rec.requests == []


def test_invalid_signer_object(rec: Recorder, client: Any) -> None:
    class NoSign:
        address = ADDR

    for bad in (None, NoSign(), FakeSigner(address="0x123")):
        with pytest.raises(ValidationError):
            client.credits.withdraw(1_000_000, bad)
    assert rec.requests == []


# ------------------------------------------------------------ payout wallet
PAYOUT = "0x" + "AB" * 20


def payout_challenge(required: bool = False, old: Any = None, **over: Any) -> dict:
    ch = {"nonce": NONCE, "expiresAt": "t", "signer": ADDR, "oldWalletSignatureRequired": required,
          "oldWalletAddress": old,
          "message": build_payout_wallet_message(USER, ADDR, PAYOUT, "base", NONCE)}
    ch.update(over)
    return ch


def test_payout_wallet_first_set(rec: Recorder, client: Any) -> None:
    rec.add(200, payout_challenge())
    rec.add(200, {"payoutWallet": {"address": PAYOUT.lower()}, "changed": False, "cooldownHours": 72})
    s = FakeSigner()
    client.payout_wallet.set(PAYOUT, s)
    assert rec.body(0) == {"address": PAYOUT.lower(), "chain": "base"}
    assert rec.requests[1].method == "PUT" and rec.requests[1].url.path == "/v1/payout-wallet"
    assert rec.body(1) == {"address": PAYOUT.lower(), "chain": "base", "nonce": NONCE, "signature": SIG}
    assert s.messages == [build_payout_wallet_message(USER, ADDR, PAYOUT, "base", NONCE)]


def test_payout_wallet_change_old_signer_signs_same_message(rec: Recorder, client: Any) -> None:
    rec.add(200, payout_challenge(True, OLD))
    rec.add(200, {"changed": True})
    s, o = FakeSigner(), FakeSigner(address=OLD, sig="0x" + "cd" * 65)
    client.payout_wallet.set(PAYOUT, s, old_wallet_signer=o)
    assert o.messages == s.messages and len(s.messages) == 1
    assert rec.body(1)["oldWalletSignature"] == "0x" + "cd" * 65


def test_payout_wallet_change_requires_old_signer(rec: Recorder, client: Any) -> None:
    rec.add(200, payout_challenge(True, OLD))
    s = FakeSigner()
    with pytest.raises(ValidationError):
        client.payout_wallet.set(PAYOUT, s)
    assert s.messages == []
    rec.add(200, payout_challenge(True, OLD))
    o = FakeSigner(address="0x" + "2" * 40)
    with pytest.raises(ValidationError):
        client.payout_wallet.set(PAYOUT, s, old_wallet_signer=o)
    assert s.messages == [] and o.messages == []


def test_payout_wallet_mismatch_refused(rec: Recorder, client: Any) -> None:
    ch = payout_challenge()
    ch["message"] = ch["message"].replace("Chain: base", "Chain: eth")
    rec.add(200, ch)
    s = FakeSigner()
    with pytest.raises(ProtocolError):
        client.payout_wallet.set(PAYOUT, s)
    assert s.messages == []


def test_payout_wallet_server_signer_mismatch(rec: Recorder, client: Any) -> None:
    rec.add(200, payout_challenge(signer=OLD))
    s = FakeSigner()
    with pytest.raises(ProtocolError):
        client.payout_wallet.set(PAYOUT, s)
    assert s.messages == []


def test_payout_wallet_validation(rec: Recorder, client: Any) -> None:
    with pytest.raises(ValidationError):
        client.payout_wallet.set("0x12", FakeSigner())
    with pytest.raises(ValidationError):
        client.payout_wallet.set(PAYOUT, FakeSigner(), chain="eth")
    assert rec.requests == []


# ------------------------------------------------------------ wallet sign-in
def test_sign_in(rec: Recorder, client: Any) -> None:
    rec.add(200, {"message": f"Sign in to DomiNode\nAddress: {ADDR.lower()}\nNonce: 1", "nonce": "1"})
    rec.add(200, {"token": "t", "refreshToken": "r"})
    s = FakeSigner()
    client.wallet_auth.sign_in(s)
    assert rec.body(1) == {"address": ADDR, "signature": SIG} and len(s.messages) == 1


def test_sign_in_refuses_challenge_without_address(rec: Recorder, client: Any) -> None:
    rec.add(200, {"message": "Sign in with 0x" + "9" * 40})
    s = FakeSigner()
    with pytest.raises(ProtocolError):
        client.wallet_auth.sign_in(s)
    assert s.messages == []


# ------------------------------------------------------------ async parity (async signer)
async def test_async_withdraw_with_async_signer(rec: Recorder) -> None:
    from conftest import ACCESS

    c = new_async_client(rec)
    rec.add(200, {"token": ACCESS, "refreshToken": ACCESS, "userId": "u"})
    await c.connect_with_key(API_KEY)

    class AsyncSigner:
        address = ADDR
        seen: List[str] = []

        async def sign_message(self, message: str) -> str:
            self.seen.append(message)
            return SIG

    rec.add(200, withdraw_challenge("1000000", "idem-12345"))
    rec.add(200, {"payout": {}, "duplicate": True})
    r = await c.credits.withdraw(1_000_000, AsyncSigner(), idempotency_key="idem-12345")
    assert r["duplicate"] is True and len(AsyncSigner.seen) == 1


async def test_async_register(rec: Recorder) -> None:
    c = new_async_client(rec)
    c._ctx.api_key = API_KEY
    rec.add(200, node_challenge())
    rec.add(200, {"nodeId": CH_ID, "nodeKey": NODE_KEY, "status": "active", "attestationVersion": 2})
    r = await c.nodes.register(FakeSigner())
    assert r["nodeKey"].reveal() == NODE_KEY


def test_sync_client_refuses_async_signer(rec: Recorder, client: Any) -> None:
    class AsyncSigner:
        address = ADDR

        async def sign_message(self, message: str) -> str:
            return SIG

    rec.add(200, withdraw_challenge("1000000", "idem-12345"))
    with pytest.raises(ProtocolError, match="awaitable"):
        client.credits.withdraw(1_000_000, AsyncSigner(), idempotency_key="idem-12345")
