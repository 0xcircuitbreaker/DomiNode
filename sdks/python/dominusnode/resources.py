"""The 15 resources (71 methods), each written once as sans-I/O generators.

``make_variants`` turns each core class into a sync and an async resource class.
Results are the server's JSON as dicts (camelCase keys, as on the wire); see types.py.
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator, Dict, Iterator, List, Mapping, Optional

from ._ops import Call, Gen, make_variants
from .constants import DEFAULT_HTTP_PROXY_PORT, DEFAULT_PROXY_HOST, DEFAULT_SOCKS5_PROXY_PORT, DEFAULT_TLS_PROXY_PORT
from .errors import AuthenticationError, ProtocolError, invalid_arg
from .http_client import Request
from .messages import (
    assert_same_message,
    build_attestation_message,
    build_payout_wallet_message,
    build_convert_message,
    build_withdraw_message,
    extract_user_id,
)
from .pow import solve_pow
from .proxy_fetch import GatewayTls, ProxyFetchResponse, build_proxy_username, execute_fetch, prepare_fetch
from .secret import Secret
from .signer import assert_signer, sign
from .ssrf import LookupAll
from .validation import (
    HEX64_RE,
    UUID_RE,
    new_idempotency_key,
    qs,
    seg,
    to_musd,
    validate_address,
    validate_api_key,
    validate_cents,
    validate_idempotency_key,
    validate_int_range,
    validate_non_empty,
    validate_optional_int,
    validate_signature,
    validate_uuid,
)
from urllib.parse import quote


class _Ctx:
    """Shared client state handed to resources (internal)."""

    def __init__(self, tokens: Any) -> None:
        self.tokens = tokens
        self.api_key: Optional[str] = None

    def __repr__(self) -> str:
        return "_Ctx([REDACTED])"


class _Base:
    def __init__(self, http: Any, ctx: _Ctx) -> None:
        self._http = http
        self._ctx = ctx

    def __repr__(self) -> str:
        return f"{type(self).__name__}()"


def _get(path: str, auth: str = "jwt") -> Request:
    return Request("GET", path, auth=auth)


def _post(path: str, body: Any = None, auth: str = "jwt", headers: Optional[Dict[str, str]] = None) -> Request:
    return Request("POST", path, {} if body is None else body, auth, dict(headers or {}))


def _put(path: str, body: Any, auth: str = "jwt") -> Request:
    return Request("PUT", path, body, auth)


def _patch(path: str, body: Any, auth: str = "jwt") -> Request:
    return Request("PATCH", path, body, auth)


def _delete(path: str, auth: str = "jwt") -> Request:
    return Request("DELETE", path, auth=auth)


def _page(limit: Any, offset: Any) -> str:
    return qs({"limit": validate_optional_int(limit, "limit"), "offset": validate_optional_int(offset, "offset")})


def _id(v: Any, name: str) -> str:
    return seg(validate_non_empty(v, name))


# ---------------------------------------------------------------- 3.1 auth
class _AuthResource(_Base):
    """Token plumbing. Human email/password, registration and MFA flows are not in the SDK."""

    def verify_key(self, api_key: str) -> Gen:
        """POST /api/auth/verify-key [none] -> {valid, token, refreshToken, userId, email}."""
        return (yield _post("/api/auth/verify-key", {"apiKey": validate_api_key(api_key)}, "none"))

    def refresh(self, refresh_token: str) -> Gen:
        """POST /api/auth/refresh [none] -> {token, refreshToken?}."""
        if not isinstance(refresh_token, str) or not refresh_token:
            raise invalid_arg("refresh_token is required")
        return (yield _post("/api/auth/refresh", {"refreshToken": refresh_token}, "none"))

    def logout(self) -> Gen:
        """POST /api/auth/logout [jwt]."""
        yield _post("/api/auth/logout", {})
        return None

    def me(self) -> Gen:
        """GET /api/auth/me [jwt] -> {user}."""
        return (yield _get("/api/auth/me"))


# ---------------------------------------------------------------- 3.2 walletAuth
class _WalletAuthResource(_Base):
    """EIP-191 wallet sign-in. Wallet-identity accounts are agent principals for /v1 routes."""

    def challenge(self, address: str) -> Gen:
        return (yield _post("/api/auth/wallet/challenge", {"address": validate_address(address)}, "none"))

    def verify(self, address: str, signature: str) -> Gen:
        """Stores the JWT pair unless the response says mfaRequired (then nothing is stored)."""
        body = {"address": validate_address(address), "signature": validate_signature(signature)}
        result = yield _post("/api/auth/wallet/verify", body, "none")
        if isinstance(result, dict) and result.get("mfaRequired") is True:
            return {"mfaRequired": True, "mfaChallengeToken": result.get("mfaChallengeToken")}
        if isinstance(result, dict) and isinstance(result.get("token"), str) and isinstance(result.get("refreshToken"), str):
            self._ctx.tokens.set_tokens(result["token"], result["refreshToken"])
        return result

    def sign_in(self, signer: Any) -> Gen:
        """challenge -> signer.sign_message -> verify. Refuses if the challenge does not name the signer."""
        assert_signer(signer)
        ch = yield from _WalletAuthResource.challenge(self, signer.address)
        msg = ch.get("message") if isinstance(ch, dict) else None
        if not isinstance(msg, str) or signer.address.lower() not in msg.lower():
            raise ProtocolError("wallet challenge does not name the signer's address; refusing to sign")
        signature = yield from sign(signer, msg)
        return (yield from _WalletAuthResource.verify(self, signer.address, signature))

    def link(self, address: str, signature: str) -> Gen:
        body = {"address": validate_address(address), "signature": validate_signature(signature)}
        return (yield _post("/api/auth/wallet/link", body))


# ---------------------------------------------------------------- 3.3 keys
class _KeysResource(_Base):
    def create(self, label: str = "Default") -> Gen:
        """POST /api/keys -> {id, prefix, label, created_at, key: Secret}."""
        validate_non_empty(label, "label", 100)
        r = yield _post("/api/keys", {"label": label})
        return {**r, "key": Secret(str(r.get("key", "")))}

    def list(self) -> Gen:
        return (yield _get("/api/keys"))

    def revoke(self, id: str) -> Gen:  # noqa: A002
        yield _delete(f"/api/keys/{_id(id, 'id')}")
        return None


# ---------------------------------------------------------------- 3.4 wallet
CRYPTO_CURRENCIES = ("btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link")


class _WalletResource(_Base):
    """Requester (prepaid) wallet in cents. Card/PayPal top-ups are not available to agents."""

    def get_balance(self) -> Gen:
        return (yield _get("/api/wallet"))

    def get_transactions(self, limit: Optional[int] = None, offset: Optional[int] = None) -> Gen:
        return (yield _get(f"/api/wallet/transactions{_page(limit, offset)}"))

    def get_forecast(self) -> Gen:
        return (yield _get("/api/wallet/forecast"))

    def top_up_crypto(self, amount_cents: int, currency: str) -> Gen:
        """$10..$1,000 (1000..100000 cents)."""
        validate_cents(amount_cents)
        if amount_cents < 1000 or amount_cents > 100_000:
            raise invalid_arg("crypto top-up must be between 1000 and 100000 cents ($10-$1,000)")
        c = str(currency).lower()
        if c not in CRYPTO_CURRENCIES:
            raise invalid_arg(f"currency must be one of {', '.join(CRYPTO_CURRENCIES)}")
        amount_usd: Any = amount_cents / 100
        if amount_cents % 100 == 0:
            amount_usd = amount_cents // 100  # serialise as 10, not 10.0 (matches JS)
        return (yield _post("/api/wallet/topup/crypto", {"amountUsd": amount_usd, "currency": c}))

    def get_crypto_status(self, invoice_id: str) -> Gen:
        return (yield _get(f"/api/wallet/crypto/status/{seg(validate_uuid(invoice_id, 'invoice_id'))}"))


# ---------------------------------------------------------------- 3.5 agenticWallets
class _AgenticWalletResource(_Base):
    def create(
        self,
        label: str,
        spending_limit_cents: int = 10000,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> Gen:
        validate_cents(spending_limit_cents, "spending_limit_cents", True)
        if daily_limit_cents is not None:
            validate_cents(daily_limit_cents, "daily_limit_cents", True)
        body: Dict[str, Any] = {"label": label, "spendingLimitCents": spending_limit_cents}
        if daily_limit_cents is not None:
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not None:
            body["allowedDomains"] = list(allowed_domains)
        return (yield _post("/api/agent-wallet", body))

    def list(self) -> Gen:
        return (yield _get("/api/agent-wallet"))

    def get(self, wallet_id: str) -> Gen:
        return (yield _get(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}"))

    def fund(self, wallet_id: str, amount_cents: int) -> Gen:
        validate_cents(amount_cents)
        return (yield _post(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}/fund", {"amountCents": amount_cents}))

    def update_wallet_policy(
        self, wallet_id: str, daily_limit_cents: Any = ..., allowed_domains: Any = ...
    ) -> Gen:
        """PATCH /{id}/policy. Pass None explicitly to clear a limit/list; omit to leave it unchanged."""
        body: Dict[str, Any] = {}
        if daily_limit_cents is not ...:
            if daily_limit_cents is not None:
                validate_cents(daily_limit_cents, "daily_limit_cents", True)
            body["dailyLimitCents"] = daily_limit_cents
        if allowed_domains is not ...:
            body["allowedDomains"] = None if allowed_domains is None else list(allowed_domains)
        return (yield _patch(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}/policy", body))

    def transactions(self, wallet_id: str, limit: Optional[int] = None, offset: Optional[int] = None) -> Gen:
        return (yield _get(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}/transactions{_page(limit, offset)}"))

    def freeze(self, wallet_id: str) -> Gen:
        return (yield _post(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}/freeze", {}))

    def unfreeze(self, wallet_id: str) -> Gen:
        return (yield _post(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}/unfreeze", {}))

    def delete(self, wallet_id: str) -> Gen:
        return (yield _delete(f"/api/agent-wallet/{_id(wallet_id, 'wallet_id')}"))


# ---------------------------------------------------------------- 3.6 teams
def _key_prefix(r: Any) -> str:
    """Server sends ``prefix``; older servers sent ``keyPrefix``."""
    if not isinstance(r, dict):
        return ""
    p = r.get("prefix", r.get("keyPrefix"))
    return p if isinstance(p, str) else ""


def _team_key(k: Dict[str, Any]) -> Dict[str, Any]:
    prefix = _key_prefix(k)
    revoked = k.get("revokedAt")
    return {
        "id": k.get("id"), "prefix": prefix, "keyPrefix": prefix, "label": k.get("label"),
        "userId": k.get("userId"), "teamId": k.get("teamId"), "createdAt": k.get("createdAt"),
        "revokedAt": revoked if isinstance(revoked, str) else None,
    }


class _TeamsResource(_Base):
    def _t(self, team_id: str) -> str:
        return f"/api/teams/{_id(team_id, 'team_id')}"

    def create(self, name: str, max_members: Optional[int] = None) -> Gen:
        body: Dict[str, Any] = {"name": name}
        if max_members is not None:
            body["maxMembers"] = validate_optional_int(max_members, "max_members")
        return (yield _post("/api/teams", body))

    def list(self) -> Gen:
        return (yield _get("/api/teams"))

    def get(self, team_id: str) -> Gen:
        return (yield _get(self._t(team_id)))

    def update(self, team_id: str, name: Optional[str] = None, max_members: Optional[int] = None) -> Gen:
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if max_members is not None:
            body["maxMembers"] = validate_optional_int(max_members, "max_members")
        return (yield _patch(self._t(team_id), body))

    def delete(self, team_id: str) -> Gen:
        return (yield _delete(self._t(team_id)))

    def fund_wallet(self, team_id: str, amount_cents: int) -> Gen:
        validate_cents(amount_cents)
        return (yield _post(f"{self._t(team_id)}/wallet/fund", {"amountCents": amount_cents}))

    def get_transactions(self, team_id: str, limit: Optional[int] = None, offset: Optional[int] = None) -> Gen:
        return (yield _get(f"{self._t(team_id)}/wallet/transactions{_page(limit, offset)}"))

    def list_members(self, team_id: str) -> Gen:
        return (yield _get(f"{self._t(team_id)}/members"))

    def add_member(self, team_id: str, email: str, role: Optional[str] = None) -> Gen:
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        return (yield _post(f"{self._t(team_id)}/members", body))

    def update_member_role(self, team_id: str, user_id: str, role: str) -> Gen:
        return (yield _patch(f"{self._t(team_id)}/members/{_id(user_id, 'user_id')}", {"role": role}))

    def remove_member(self, team_id: str, user_id: str) -> Gen:
        yield _delete(f"{self._t(team_id)}/members/{_id(user_id, 'user_id')}")
        return None

    def create_invite(self, team_id: str, email: str, role: Optional[str] = None) -> Gen:
        body: Dict[str, Any] = {"email": email}
        if role is not None:
            body["role"] = role
        return (yield _post(f"{self._t(team_id)}/invites", body))

    def list_invites(self, team_id: str) -> Gen:
        return (yield _get(f"{self._t(team_id)}/invites"))

    def cancel_invite(self, team_id: str, invite_id: str) -> Gen:
        yield _delete(f"{self._t(team_id)}/invites/{_id(invite_id, 'invite_id')}")
        return None

    def accept_invite(self, token: str) -> Gen:
        return (yield _post(f"/api/teams/invites/{_id(token, 'token')}/accept", {}))

    def create_key(self, team_id: str, label: str) -> Gen:
        """POST /{teamId}/keys -> {id, prefix, keyPrefix (alias), label, key: Secret}. Team keys cannot call /v1 routes."""
        validate_non_empty(label, "label", 100)
        r = yield _post(f"{self._t(team_id)}/keys", {"label": label})
        prefix = _key_prefix(r)
        return {**r, "prefix": prefix, "keyPrefix": prefix, "key": Secret(str(r.get("key", "")))}

    def list_keys(self, team_id: str) -> Gen:
        """-> {keys: [{id, prefix, keyPrefix (alias), label, userId, teamId, createdAt, revokedAt}]}."""
        r = yield _get(f"{self._t(team_id)}/keys")
        keys = r.get("keys") if isinstance(r, dict) else None
        return {"keys": [_team_key(k) for k in keys if isinstance(k, dict)] if isinstance(keys, list) else []}

    def revoke_key(self, team_id: str, key_id: str) -> Gen:
        yield _delete(f"{self._t(team_id)}/keys/{_id(key_id, 'key_id')}")
        return None


# ---------------------------------------------------------------- 3.7 usage
class _UsageResource(_Base):
    """Date range: ``from_`` -> query ``since``, ``to`` -> ``until`` (ISO 8601)."""

    def get(
        self, from_: Optional[str] = None, to: Optional[str] = None, limit: Optional[int] = None, offset: Optional[int] = None
    ) -> Gen:
        q = qs({"since": from_, "until": to, "limit": validate_optional_int(limit, "limit"),
                "offset": validate_optional_int(offset, "offset")})
        return (yield _get(f"/api/usage{q}"))

    def get_daily(self, from_: Optional[str] = None, to: Optional[str] = None) -> Gen:
        return (yield _get(f"/api/usage/daily{qs({'since': from_, 'until': to})}"))

    def get_top_hosts(self, from_: Optional[str] = None, to: Optional[str] = None, limit: Optional[int] = None) -> Gen:
        q = qs({"since": from_, "until": to, "limit": validate_optional_int(limit, "limit")})
        return (yield _get(f"/api/usage/top-hosts{q}"))

    def export_csv(self, from_: Optional[str] = None, to: Optional[str] = None) -> Gen:
        """Raw CSV text."""
        return (yield Request("GET", f"/api/usage/export{qs({'since': from_, 'until': to})}", raw=True))


# ---------------------------------------------------------------- 3.8 sessions
REPORT_REASONS = ("blocked", "captcha", "rate_limited", "slow", "bad_content", "other")


class _SessionsResource(_Base):
    def get_active(self) -> Gen:
        """ActiveSession = {id, startedAt, status} ONLY; IPs and unknown fields are dropped."""
        r = yield _get("/api/sessions/active")
        raw = r.get("sessions") if isinstance(r, dict) else None
        sessions = [
            {"id": str(s.get("id")), "startedAt": str(s.get("startedAt")), "status": str(s.get("status"))}
            for s in (raw if isinstance(raw, list) else [])
            if isinstance(s, dict)
        ]
        return {"sessions": sessions}

    def report(self, session_id: str, reason: str) -> Gen:
        """POST /v1/sessions/{id}/report [agent] -> {reportId, reportsToday, limitPerDay}."""
        validate_uuid(session_id, "session_id")
        if reason not in REPORT_REASONS:
            raise invalid_arg(f"reason must be one of {', '.join(REPORT_REASONS)}")
        return (yield _post(f"/v1/sessions/{seg(session_id)}/report", {"reason": reason}, "agent"))


# ---------------------------------------------------------------- 3.9 x402
class _X402Resource(_Base):
    def get_info(self) -> Gen:
        """GET /api/x402/info [none]. Prices are server-reported; the SDK hardcodes none."""
        return (yield _get("/api/x402/info", "none"))


# ---------------------------------------------------------------- 3.10 network
class _NetworkResource(_Base):
    def policy(self) -> Gen:
        return (yield _get("/v1/policy", "none"))

    def pricing(self) -> Gen:
        """Live per-GB price by IP class (µUSD strings)."""
        return (yield _get("/v1/pricing", "none"))

    def stats(self) -> Gen:
        return (yield _get("/v1/network/stats", "none"))


# ---------------------------------------------------------------- 3.11 nodes
NODE_KEY_RE = re.compile(r"^dn_node_[0-9a-f]{64}\Z")
MAX_ATTESTATION_TEXT = 64 * 1024


def _norm_pubkey(v: Any) -> Optional[str]:
    if v is None:
        return None
    k = v.lower() if isinstance(v, str) else ""
    if not HEX64_RE.match(k):
        raise invalid_arg("node_pubkey must be 64 hex characters (32-byte ed25519 public key)")
    return k


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _check_challenge(ch: Any) -> None:
    if not isinstance(ch, dict):
        raise ProtocolError("invalid node challenge")
    if not isinstance(ch.get("nonce"), str) or not HEX64_RE.match(ch["nonce"]):
        raise ProtocolError("invalid challenge nonce")
    text = ch.get("attestationText")
    if not isinstance(text, str) or not text or len(text) > MAX_ATTESTATION_TEXT:
        raise ProtocolError("invalid attestation text")
    ver = ch.get("attestationVersion")
    if not _is_int(ver) or ver < 1 or ver > 100_000:
        raise ProtocolError("invalid attestation version")
    p = ch.get("powChallenge")
    if (
        not isinstance(p, dict)
        or not isinstance(p.get("prefix"), str)
        or not isinstance(p.get("difficulty"), (int, float))
        or isinstance(p.get("difficulty"), bool)
        or not isinstance(p.get("challengeId"), str)
        or not UUID_RE.match(p["challengeId"])
    ):
        raise ProtocolError("invalid PoW challenge")


class _NodesResource(_Base):
    """Relay nodes you own. All routes are /v1 agent routes."""

    def register_challenge(self, node_pubkey: Optional[str] = None) -> Gen:
        pk = _norm_pubkey(node_pubkey)
        return (yield _post("/v1/nodes/challenge", {"nodePubkey": pk} if pk else {}, "agent"))

    def register(
        self,
        signer: Any,
        node_pubkey: Optional[str] = None,
        challenge: Optional[Dict[str, Any]] = None,
        max_streams: Optional[int] = None,
        max_gb_day: Optional[int] = None,
        max_pow_iterations: int = 200_000_000,
        declared_class: Optional[str] = None,
    ) -> Gen:
        """challenge -> rebuild attestation (refuse on mismatch) -> PoW -> sign -> POST /v1/nodes.

        Returns {nodeId, status, attestationVersion, nodeKey: Secret}; the node key is shown once.
        """
        assert_signer(signer)
        pk = _norm_pubkey(node_pubkey)
        if max_streams is not None:
            validate_int_range(max_streams, "max_streams", 1, 1024)
        if max_gb_day is not None:
            validate_int_range(max_gb_day, "max_gb_day", 1, 10_000)
        validate_int_range(max_pow_iterations, "max_pow_iterations", 1, 10**12)
        if declared_class is not None and declared_class not in EXIT_CLASSES:
            raise invalid_arg("declared_class must be residential, mobile, dc or masked")
        ch = challenge if challenge is not None else (yield from _NodesResource.register_challenge(self, pk))
        _check_challenge(ch)
        message = build_attestation_message(signer.address, ch["nonce"], ch["attestationVersion"], ch["attestationText"], pk)
        assert_same_message(ch.get("message"), message, "node attestation")
        pow_ch = ch["powChallenge"]
        diff = pow_ch["difficulty"]
        if isinstance(diff, float):
            if diff != diff or not diff.is_integer():
                raise ProtocolError("invalid PoW difficulty")
            diff = int(diff)
        pow_nonce = yield Call(solve_pow, (pow_ch["prefix"], diff, max_pow_iterations))
        wallet_signature = yield from sign(signer, message)
        body: Dict[str, Any] = {
            "nonce": ch["nonce"],
            "walletSignature": wallet_signature,
            "attestationVersion": ch["attestationVersion"],
            "pow": {"challengeId": pow_ch["challengeId"], "nonce": pow_nonce},
        }
        if pk:
            body["nodePubkey"] = pk
        if max_streams is not None:
            body["maxStreams"] = max_streams
        if max_gb_day is not None:
            body["maxGbDay"] = max_gb_day
        if declared_class is not None:
            body["declaredClass"] = declared_class
        r = yield _post("/v1/nodes", body, "agent")
        if not isinstance(r, dict) or not isinstance(r.get("nodeId"), str) or not UUID_RE.match(r["nodeId"]):
            raise ProtocolError("invalid nodeId in response")
        if not isinstance(r.get("nodeKey"), str) or not NODE_KEY_RE.match(r["nodeKey"]):
            raise ProtocolError("invalid node key in response")
        return {
            "nodeId": r["nodeId"],
            "status": str(r.get("status")),
            "attestationVersion": r.get("attestationVersion"),
            "nodeKey": Secret(r["nodeKey"]),
        }

    def list(self, limit: Optional[int] = None, offset: Optional[int] = None, cursor: Optional[str] = None) -> Gen:
        """Pass ``cursor`` (a previous nextCursor) or ``offset``."""
        if limit is not None:
            validate_int_range(limit, "limit", 1, 500)
        if offset is not None:
            validate_int_range(offset, "offset", 0, 1_000_000)
        if cursor is not None:
            validate_page_cursor(cursor)
        return (yield _get(f"/v1/nodes{qs({'limit': limit, 'offset': offset, 'cursor': cursor})}", "agent"))

    def revoke(self, node_id: str) -> Gen:
        """Irreversible."""
        return (yield _delete(f"/v1/nodes/{seg(validate_uuid(node_id, 'node_id'))}", "agent"))

    def update_caps(
        self,
        node_id: str,
        max_streams: Optional[int] = None,
        gb_per_day: Optional[int] = None,
        req_per_sec: Optional[int] = None,
    ) -> Gen:
        """Lower caps only (server: CAP_ABOVE_DEFAULT with details['max'])."""
        validate_uuid(node_id, "node_id")
        body: Dict[str, int] = {}
        for wire, name, v in (("maxStreams", "max_streams", max_streams), ("gbPerDay", "gb_per_day", gb_per_day),
                              ("reqPerSec", "req_per_sec", req_per_sec)):
            if v is not None:
                body[wire] = validate_int_range(v, name, 1, 1_000_000)
        if not body:
            raise invalid_arg("update_caps needs at least one of max_streams, gb_per_day, req_per_sec")
        return (yield _patch(f"/v1/nodes/{seg(node_id)}", body, "agent"))

    def tier(self) -> Gen:
        return (yield _get("/v1/node/tier", "agent"))


# ---------------------------------------------------------------- 3.12 credits
CREDIT_TX_TYPES = ("earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal")
MIN_CONVERT_MUSD = 10_000
MAX_CONVERT_MUSD = 10_000_000_000
MIN_WITHDRAW_MUSD = 1_000_000
MAX_WITHDRAW_MUSD = 100_000_000_000
_CURSOR_RE = re.compile(r"^[1-9][0-9]{0,18}\Z")
# Exit classes of a node's egress IP (2.1).
EXIT_CLASSES = ("residential", "mobile", "dc", "masked")
# Opaque server cursor for /v1/nodes and /v1/payouts (2.1).
_PAGE_CURSOR_RE = re.compile(r"^[A-Za-z0-9_\-=+/.:]{1,512}\Z")


def validate_page_cursor(cursor: Any) -> str:
    if not isinstance(cursor, str) or not _PAGE_CURSOR_RE.match(cursor):
        raise invalid_arg("cursor must be a nextCursor value")
    return cursor


def _check_signed_challenge(ch: Any, signer: Any) -> Dict[str, Any]:
    if not isinstance(ch, dict) or not isinstance(ch.get("nonce"), str) or not HEX64_RE.match(ch["nonce"]):
        raise ProtocolError("invalid challenge nonce")
    s = ch.get("signer")
    if not isinstance(s, str) or s.lower() != signer.address.lower():
        raise ProtocolError("the account's linked wallet is not the signer's address; refusing to sign")
    return ch


class _CreditsResource(_Base):
    """Node-operator earnings in µUSD. /v1 agent routes."""

    def balance(self) -> Gen:
        return (yield _get("/v1/credits", "agent"))

    def transactions(self, limit: Optional[int] = None, cursor: Optional[str] = None, type: Optional[str] = None) -> Gen:  # noqa: A002
        if limit is not None:
            validate_int_range(limit, "limit", 1, 200)
        if cursor is not None and (not isinstance(cursor, str) or not _CURSOR_RE.match(cursor)):
            raise invalid_arg("cursor must be a nextCursor value")
        if type is not None and type not in CREDIT_TX_TYPES:
            raise invalid_arg(f"type must be one of {', '.join(CREDIT_TX_TYPES)}")
        return (yield _get(f"/v1/credits/transactions{qs({'limit': limit, 'cursor': cursor, 'type': type})}", "agent"))

    def convert(self, amount_musd: Any, signer: Any, idempotency_key: Optional[str] = None) -> Gen:
        """10,000 <= amount_musd <= 10,000,000,000. challenge -> rebuild message (refuse on mismatch)
        -> linked wallet signs -> POST /v1/credits/convert. The key is echoed so callers can retry."""
        assert_signer(signer)
        amount = to_musd(amount_musd, MIN_CONVERT_MUSD, MAX_CONVERT_MUSD)
        key = validate_idempotency_key(idempotency_key if idempotency_key is not None else new_idempotency_key())
        hdr = {"Idempotency-Key": key}
        ch = yield _post("/v1/credits/convert/challenge", {"amountMusd": amount}, "agent", hdr)
        _check_signed_challenge(ch, signer)
        server_msg = ch.get("message")
        local = build_convert_message(extract_user_id(str(server_msg)), signer.address, amount, key, ch["nonce"])
        assert_same_message(server_msg, local, "credit conversion")
        signature = yield from sign(signer, local)
        body = {"amountMusd": amount, "nonce": ch["nonce"], "signature": signature}
        r = yield _post("/v1/credits/convert", body, "agent", hdr)
        return {**r, "idempotencyKey": key}

    def withdraw(self, amount_musd: Any, signer: Any, idempotency_key: Optional[str] = None) -> Gen:
        """challenge -> rebuild message (refuse on mismatch) -> linked wallet signs -> POST /v1/credits/withdraw."""
        assert_signer(signer)
        amount = to_musd(amount_musd, MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD)
        key = validate_idempotency_key(idempotency_key if idempotency_key is not None else new_idempotency_key())
        ch = yield _post("/v1/credits/withdraw/challenge", {"amountMusd": amount, "idempotencyKey": key}, "agent")
        _check_signed_challenge(ch, signer)
        server_msg = ch.get("message")
        local = build_withdraw_message(extract_user_id(str(server_msg)), signer.address, amount, key, ch["nonce"])
        assert_same_message(server_msg, local, "withdrawal")
        signature = yield from sign(signer, local)
        body = {"amountMusd": amount, "idempotencyKey": key, "nonce": ch["nonce"], "signature": signature}
        r = yield _post("/v1/credits/withdraw", body, "agent")
        return {**r, "idempotencyKey": key}


# ---------------------------------------------------------------- 3.13 payoutWallet
# base-sepolia is an explicit opt-in for staging; the server decides whether it is accepted.
PAYOUT_CHAINS = ("base", "base-sepolia")


class _PayoutWalletResource(_Base):
    def get(self) -> Gen:
        return (yield _get("/v1/payout-wallet", "agent"))

    def set(self, address: str, signer: Any, chain: str = "base", old_wallet_signer: Any = None) -> Gen:
        """Register or change the payout wallet (old wallet co-signs the SAME message when required)."""
        assert_signer(signer)
        addr = validate_address(address).lower()
        if chain not in PAYOUT_CHAINS:
            raise invalid_arg("chain must be 'base' or 'base-sepolia'")
        if old_wallet_signer is not None:
            assert_signer(old_wallet_signer, "old_wallet_signer")
        ch = yield _post("/v1/payout-wallet/challenge", {"address": addr, "chain": chain}, "agent")
        _check_signed_challenge(ch, signer)
        server_msg = ch.get("message")
        local = build_payout_wallet_message(extract_user_id(str(server_msg)), signer.address, addr, chain, ch["nonce"])
        assert_same_message(server_msg, local, "payout wallet")
        required = ch.get("oldWalletSignatureRequired") is True
        if required:
            if old_wallet_signer is None:
                raise invalid_arg(f"changing the payout wallet requires old_wallet_signer for {ch.get('oldWalletAddress')}")
            old = ch.get("oldWalletAddress")
            if not isinstance(old, str) or old.lower() != old_wallet_signer.address.lower():
                raise invalid_arg("old_wallet_signer.address is not the current payout wallet")
        signature = yield from sign(signer, local)
        body = {"address": addr, "chain": chain, "nonce": ch["nonce"], "signature": signature}
        if required:
            body["oldWalletSignature"] = yield from sign(old_wallet_signer, local, "old_wallet_signer")
        return (yield _put("/v1/payout-wallet", body, "agent"))


# ---------------------------------------------------------------- 3.14 payouts
class _PayoutsResource(_Base):
    def list(self, limit: Optional[int] = None, offset: Optional[int] = None, cursor: Optional[str] = None) -> Gen:
        """Pass ``cursor`` (a previous nextCursor) or ``offset``."""
        if limit is not None:
            validate_int_range(limit, "limit", 1, 200)
        if offset is not None:
            validate_int_range(offset, "offset", 0, 1_000_000)
        if cursor is not None:
            validate_page_cursor(cursor)
        return (yield _get(f"/v1/payouts{qs({'limit': limit, 'offset': offset, 'cursor': cursor})}", "agent"))


# ---------------------------------------------------------------- 3.15 proxy
_PROXY_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}\Z|^\[[0-9A-Fa-f:.]+\]\Z")


def _valid_port(p: Any, name: str) -> int:
    if not _is_int(p) or p < 1 or p > 65535:
        raise invalid_arg(f"{name} must be a TCP port")
    return int(p)


def _gateway_tls(g: Any) -> Optional[GatewayTls]:
    """``False`` -> plaintext (local dev only); ``None`` (default, 2.2+) or ``True`` -> TLS on port 8443;
    mapping ``{port, ca, servername}`` or GatewayTls. Production gateways refuse credentials on 8080/1080."""
    if g is False:
        return None
    if g is None or g is True:
        return GatewayTls()
    if isinstance(g, GatewayTls):
        g = {"port": g.port, "ca": g.ca, "servername": g.servername}
    if not isinstance(g, Mapping):
        raise invalid_arg("gateway_tls must be a bool, a mapping or GatewayTls")
    unknown = set(g) - {"port", "ca", "servername"}
    if unknown:
        raise invalid_arg("gateway_tls has unknown fields")
    port = g.get("port")
    port = DEFAULT_TLS_PROXY_PORT if port is None else _valid_port(port, "gateway_tls.port")
    sn = g.get("servername")
    if sn is not None and (not isinstance(sn, str) or not _SERVERNAME_RE.match(sn)):
        raise invalid_arg("gateway_tls.servername is invalid")
    ca = g.get("ca")
    if ca is not None and not isinstance(ca, (str, bytes)):
        raise invalid_arg("gateway_tls.ca must be a PEM string or bytes")
    return GatewayTls(port, ca, sn)


_SERVERNAME_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}\Z")


class _ProxyResource(_Base):
    """Gateway helpers. API key in the PASSWORD; routing flags in the USERNAME (hyphen-joined)."""

    def __init__(
        self,
        http: Any,
        ctx: _Ctx,
        proxy_host: str = DEFAULT_PROXY_HOST,
        http_proxy_port: int = DEFAULT_HTTP_PROXY_PORT,
        socks5_proxy_port: int = DEFAULT_SOCKS5_PROXY_PORT,
        gateway_tls: Any = None,
    ) -> None:
        super().__init__(http, ctx)
        if not isinstance(proxy_host, str) or not _PROXY_HOST_RE.match(proxy_host):
            raise invalid_arg("proxy_host contains invalid characters")
        self._host = proxy_host
        self._http_port = _valid_port(http_proxy_port, "http_proxy_port")
        self._socks_port = _valid_port(socks5_proxy_port, "socks5_proxy_port")
        self._tls = _gateway_tls(gateway_tls)
        self._lookup: Optional[LookupAll] = None

    def set_lookup(self, lookup: Optional[LookupAll]) -> None:
        """Inject a DNS resolver (tests)."""
        self._lookup = lookup

    def _key(self, override: Optional[str]) -> str:
        k = override if override is not None else self._ctx.api_key
        if not k:
            raise AuthenticationError("proxy access needs an API key: call connect_with_key() or pass api_key")
        return validate_api_key(k)

    def build_username(
        self,
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        agentic_wallet_id: Optional[str] = None,
        allow_http: bool = False,
    ) -> str:
        return build_proxy_username(country, ip_class, session_id, agentic_wallet_id, allow_http)

    def build_url(
        self,
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        agentic_wallet_id: Optional[str] = None,
        allow_http: bool = False,
        protocol: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> str:
        """e.g. http://country-US-class-dc:dn_live_...@proxy.dominusnode.com:8080. CONTAINS the key: do not log it.

        ``protocol``: http, https (TLS to the gateway; needs gateway_tls) or socks5.
        Default: https when gateway_tls is configured, else http."""
        if protocol is None:
            protocol = "https" if self._tls is not None else "http"
        if protocol not in ("http", "https", "socks5"):
            raise invalid_arg("protocol must be http, https or socks5")
        if protocol == "https" and self._tls is None:
            raise invalid_arg("protocol https needs the gateway_tls config")
        if protocol == "socks5":
            port = self._socks_port
        elif protocol == "https":
            port = self._tls.port  # type: ignore[union-attr]
        else:
            port = self._http_port
        user = build_proxy_username(country, ip_class, session_id, agentic_wallet_id, allow_http)
        key = self._key(api_key)
        return f"{protocol}://{quote(user, safe='')}:{quote(key, safe='')}@{self._host}:{port}"

    def fetch(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        timeout_ms: Optional[float] = None,
        max_bytes: Optional[int] = None,
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        agentic_wallet_id: Optional[str] = None,
        allow_http: bool = False,
        api_key: Optional[str] = None,
    ) -> Gen:
        """GET/HEAD through the relay. Redirects returned, not followed; body capped at max_bytes (10 MB)."""
        key = self._key(api_key)
        prepared = prepare_fetch(
            key, url, method, headers, timeout_ms, max_bytes, country, ip_class, session_id, agentic_wallet_id, allow_http
        )
        host = self._host.strip("[]")
        result: ProxyFetchResponse = yield Call(execute_fetch, (host, self._http_port, prepared, self._lookup, self._tls))
        return result

    def get_health(self) -> Gen:
        """-> {status}. The server returns only the gateway status."""
        r = yield _get("/api/proxy/health", "none")
        status = r.get("status") if isinstance(r, dict) else None
        return {"status": status if isinstance(status, str) else "unknown"}

    def get_config(self) -> Gen:
        return (yield _get("/api/proxy/config"))


AuthResource, AsyncAuthResource = make_variants(_AuthResource)
WalletAuthResource, AsyncWalletAuthResource = make_variants(_WalletAuthResource)
KeysResource, AsyncKeysResource = make_variants(_KeysResource)
WalletResource, AsyncWalletResource = make_variants(_WalletResource)
AgenticWalletResource, AsyncAgenticWalletResource = make_variants(_AgenticWalletResource)
TeamsResource, AsyncTeamsResource = make_variants(_TeamsResource)
UsageResource, AsyncUsageResource = make_variants(_UsageResource)
SessionsResource, AsyncSessionsResource = make_variants(_SessionsResource)
X402Resource, AsyncX402Resource = make_variants(_X402Resource)
NetworkResource, AsyncNetworkResource = make_variants(_NetworkResource)
NodesResource, AsyncNodesResource = make_variants(_NodesResource)
CreditsResource, AsyncCreditsResource = make_variants(_CreditsResource)
PayoutWalletResource, AsyncPayoutWalletResource = make_variants(_PayoutWalletResource)
PayoutsResource, AsyncPayoutsResource = make_variants(_PayoutsResource)
ProxyResource, AsyncProxyResource = make_variants(_ProxyResource)


# ---------------------------------------------------------------- pagination helpers
# Sync variants are generators, async variants async generators. ``limit`` is the page size.
_MAX_OFFSET = 1_000_000


def _page_cursor(page: Any, items: List[Any], cursor: Optional[str]) -> Optional[str]:
    nxt = page.get("nextCursor") if isinstance(page, dict) else None
    if not items or not isinstance(nxt, str) or not _PAGE_CURSOR_RE.match(nxt) or nxt == cursor:
        return None
    return nxt


def _offset_pager(list_method: str, items_key: str, default_limit: int, max_limit: int, total: bool = False, cursors: bool = False) -> Any:
    def _done(page: Any, items: List[Any], limit: int, offset: int) -> bool:
        if len(items) < limit:
            return True
        if total and isinstance(page, dict):
            t = (page.get("pagination") or {}).get("total")
            if isinstance(t, int) and offset + len(items) >= t:
                return True
        return False

    def _items(page: Any) -> List[Any]:
        v = page.get(items_key) if isinstance(page, dict) else None
        return v if isinstance(v, list) else []

    def sync_iter(self: Any, limit: Optional[int] = None, **kwargs: Any) -> Iterator[Any]:
        lim = validate_int_range(default_limit if limit is None else limit, "limit", 1, max_limit)
        offset = 0
        cursor: Optional[str] = None
        while offset <= _MAX_OFFSET:
            if cursor is not None:
                page = getattr(self, list_method)(limit=lim, cursor=cursor, **kwargs)
            else:
                page = getattr(self, list_method)(limit=lim, offset=offset, **kwargs)
            items = _items(page)
            yield from items
            if cursors and isinstance(page, dict) and "nextCursor" in page:
                cursor = _page_cursor(page, items, cursor)
                if cursor is None:
                    return
                continue
            if _done(page, items, lim, offset):
                return
            offset += lim

    async def async_iter(self: Any, limit: Optional[int] = None, **kwargs: Any) -> AsyncIterator[Any]:
        lim = validate_int_range(default_limit if limit is None else limit, "limit", 1, max_limit)
        offset = 0
        cursor: Optional[str] = None
        while offset <= _MAX_OFFSET:
            if cursor is not None:
                page = await getattr(self, list_method)(limit=lim, cursor=cursor, **kwargs)
            else:
                page = await getattr(self, list_method)(limit=lim, offset=offset, **kwargs)
            items = _items(page)
            for item in items:
                yield item
            if cursors and isinstance(page, dict) and "nextCursor" in page:
                cursor = _page_cursor(page, items, cursor)
                if cursor is None:
                    return
                continue
            if _done(page, items, lim, offset):
                return
            offset += lim

    return sync_iter, async_iter


def _next_cursor(page: Any, items: List[Any], cursor: Optional[str]) -> Optional[str]:
    nxt = page.get("nextCursor") if isinstance(page, dict) else None
    if not items or not isinstance(nxt, str) or not _CURSOR_RE.match(nxt) or nxt == cursor:
        return None
    return nxt


def _credit_items(page: Any) -> List[Any]:
    v = page.get("transactions") if isinstance(page, dict) else None
    return v if isinstance(v, list) else []


def _credits_iter_sync(self: Any, limit: Optional[int] = None, type: Optional[str] = None, cursor: Optional[str] = None) -> Iterator[Any]:  # noqa: A002
    """Every credit transaction (newest first), following nextCursor."""
    while True:
        page = self.transactions(limit=limit, cursor=cursor, type=type)
        items = _credit_items(page)
        yield from items
        cursor = _next_cursor(page, items, cursor)
        if cursor is None:
            return


async def _credits_iter_async(self: Any, limit: Optional[int] = None, type: Optional[str] = None, cursor: Optional[str] = None) -> AsyncIterator[Any]:  # noqa: A002
    """Every credit transaction (newest first), following nextCursor."""
    while True:
        page = await self.transactions(limit=limit, cursor=cursor, type=type)
        items = _credit_items(page)
        for item in items:
            yield item
        cursor = _next_cursor(page, items, cursor)
        if cursor is None:
            return


CreditsResource.iter_transactions = _credits_iter_sync  # type: ignore[attr-defined]
AsyncCreditsResource.iter_transactions = _credits_iter_async  # type: ignore[attr-defined]
for _sync_cls, _async_cls, _name, _args in (
    (PayoutsResource, AsyncPayoutsResource, "iterate", ("list", "payouts", 50, 200, False, True)),
    (NodesResource, AsyncNodesResource, "iterate", ("list", "nodes", 100, 500, False, True)),
    (WalletResource, AsyncWalletResource, "iter_transactions", ("get_transactions", "transactions", 50, 100)),
):
    _s, _a = _offset_pager(*_args)
    setattr(_sync_cls, _name, _s)
    setattr(_async_cls, _name, _a)
_s, _a = _offset_pager("get", "records", 200, 1000, total=True)
UsageResource.iter_records = _s  # type: ignore[attr-defined]
AsyncUsageResource.iter_records = _a  # type: ignore[attr-defined]
