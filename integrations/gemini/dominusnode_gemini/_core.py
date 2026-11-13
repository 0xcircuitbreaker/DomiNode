"""DominusNode v2 standard tool set (19 tools), built on the ``dominusnode`` Python SDK.

Framework-neutral: each tool has a name, an LLM-facing description and a JSON
Schema for its arguments. ``DominusNodeTools.call(name, args)`` dispatches to
the SDK and always returns a JSON string with credentials scrubbed. HTTP,
SSRF/DNS-rebinding checks, OFAC refusal and signing all live in the SDK.

The API key is read only from ``DOMINUSNODE_API_KEY`` (or passed by the host
application as configuration); it is never a tool argument or tool output.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable, Dict, List, Optional

from dominusnode import DominusNodeClient, DominusNodeError, scrub_credentials, json_default

PREFIX = "dominusnode_"
MAX_BODY_CHARS = 20_000
_KEY_PLACEHOLDER = "${DOMINUSNODE_API_KEY}"

_COUNTRY = {"type": "string", "description": "ISO 3166-1 alpha-2 exit country, e.g. US. Sanctioned countries are refused."}
_IP_CLASS = {"type": "string", "enum": ["residential", "dc", "mobile", "masked"],
             "description": "Exit IP class. Each class has its own per-GB price (see network_pricing); masked = cheapest, VPN/anonymizer exits, opt-in."}
_SESSION = {"type": "string", "description": "Sticky session id (1-64 alphanumeric) to keep the same exit IP."}
_ALLOW_HTTP = {"type": "boolean",
               "description": "Opt in to plaintext http:// targets. Plaintext is visible to the exit node; prefer https."}
_LIMIT = {"type": "integer", "minimum": 1, "description": "Maximum number of items."}
_OFFSET = {"type": "integer", "minimum": 0, "description": "Items to skip."}


def _obj(props: Optional[Dict[str, Any]] = None, required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {"type": "object", "properties": props or {}, "required": required or [], "additionalProperties": False}


TOOL_SPECS: List[Dict[str, Any]] = [
    {"name": "fetch", "description": (
        "Fetch a public URL through the DominusNode relay network (GET or HEAD only, ports 80/443, no redirects "
        "followed, 10 MB cap, private/internal targets refused). Billed per GB at the live price for the exit IP "
        "class (see network_pricing). http:// targets need allow_http=true and are visible to the exit node."),
     "parameters": _obj({"url": {"type": "string", "description": "https:// URL (or http:// with allow_http)."},
                         "method": {"type": "string", "enum": ["GET", "HEAD"], "description": "HTTP method."},
                         "country": _COUNTRY, "ip_class": _IP_CLASS, "session_id": _SESSION,
                         "allow_http": _ALLOW_HTTP}, ["url"])},
    {"name": "proxy_url", "description": (
        "Build a relay gateway proxy URL for use in other HTTP clients. Routing flags go in the username "
        "(country-XX, class-..., session-..., allowhttp-1). The password is shown as a ${DOMINUSNODE_API_KEY} "
        "placeholder: substitute the key from the environment, never paste it into chat."),
     "parameters": _obj({"country": _COUNTRY, "ip_class": _IP_CLASS, "session_id": _SESSION, "allow_http": _ALLOW_HTTP,
                         "protocol": {"type": "string", "enum": ["https", "socks5", "http"],
                                      "description": "https (default: TLS to the gateway), socks5, or http (plaintext gateway; local dev only)."}})},
    {"name": "network_policy", "description": (
        "Relay network policy: allowed ports, plaintext (allowhttp) rules, blocked ranges, sanctioned countries "
        "and node attestation terms."), "parameters": _obj()},
    {"name": "network_pricing", "description": (
        "Live per-GB prices by exit IP class (residential, dc, mobile, masked) and node tier revenue shares. Always use "
        "this for prices; never assume them."), "parameters": _obj()},
    {"name": "network_stats", "description": "Relay network statistics: online nodes, exit countries and IP classes.",
     "parameters": _obj()},
    {"name": "balance", "description": "Prepaid requester wallet balance (cents) used to pay for relayed traffic.",
     "parameters": _obj()},
    {"name": "transactions", "description": "Requester wallet transaction history (top-ups, usage debits, credit conversions).",
     "parameters": _obj({"limit": _LIMIT, "offset": _OFFSET})},
    {"name": "topup_crypto", "description": (
        "Create a crypto invoice to top up the requester wallet ($10-$1,000). Returns a payment address/URL; "
        "the wallet is credited after on-chain confirmation (check with check_payment)."),
     "parameters": _obj({"amount_cents": {"type": "integer", "minimum": 1000, "maximum": 100000,
                                          "description": "Amount in US cents (1000 = $10)."},
                         "currency": {"type": "string", "enum": ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol",
                                                                 "usdt", "dai", "bnb", "link"],
                                      "description": "Cryptocurrency to pay with."}}, ["amount_cents", "currency"])},
    {"name": "check_payment", "description": "Status of a crypto top-up invoice created by topup_crypto.",
     "parameters": _obj({"invoice_id": {"type": "string", "description": "Invoice UUID."}}, ["invoice_id"])},
    {"name": "usage", "description": "Relayed traffic usage summary (bytes and cost) for an optional ISO 8601 date range.",
     "parameters": _obj({"from": {"type": "string", "description": "ISO 8601 start."},
                         "to": {"type": "string", "description": "ISO 8601 end."}})},
    {"name": "active_sessions", "description": "Your currently active relay sessions (id, start time, status).",
     "parameters": _obj()},
    {"name": "report_session", "description": (
        "Report a burned or bad exit for one of your relay sessions so the network can rotate it."),
     "parameters": _obj({"session_id": {"type": "string", "description": "Session UUID from active_sessions."},
                         "reason": {"type": "string", "enum": ["blocked", "captcha", "rate_limited", "slow",
                                                               "bad_content", "other"],
                                    "description": "Why the exit is bad."}}, ["session_id", "reason"])},
    {"name": "node_list", "description": (
        "Relay nodes you contribute (status, observed IP class, last seen). Contributing IPs earns credit."),
     "parameters": _obj({"limit": _LIMIT, "offset": _OFFSET})},
    {"name": "node_tier", "description": (
        "Your node-operator tier, revenue share and progress toward the next tier (tenure, uptime, active IPs, reputation)."),
     "parameters": _obj()},
    {"name": "node_setup_guide", "description": (
        "Step-by-step instructions to earn by contributing an IP: run the DominusNode node agent, register a node, "
        "and how tiers and the self-dealing rule work."), "parameters": _obj()},
    {"name": "credits_balance", "description": "Node-operator earnings: pending and available credit (µUSD).",
     "parameters": _obj()},
    {"name": "credits_convert", "description": (
        "Convert available node earnings into your own requester wallet balance (idempotent; returns the idempotency key)."),
     "parameters": _obj({"amount_musd": {"type": "string",
                                         "description": "Amount in micro-USD as a digit string (min 10000 = $0.01)."}},
                        ["amount_musd"])},
    {"name": "payouts_list", "description": "Your USDC payouts of node earnings with status and transaction hash.",
     "parameters": _obj({"limit": _LIMIT, "offset": _OFFSET})},
    {"name": "x402_info", "description": "x402 micropayment info: facilitators, networks and server-reported prices.",
     "parameters": _obj()},
]

TOOL_NAMES: List[str] = [t["name"] for t in TOOL_SPECS]
SPECS_BY_NAME: Dict[str, Dict[str, Any]] = {t["name"]: t for t in TOOL_SPECS}

NODE_SETUP_GUIDE = "\n".join([
    "DominusNode relay node setup (earn by contributing an IP)",
    "",
    "How earning works",
    "  - Your node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.",
    "  - You earn your tier's share of each paid GB relayed; live prices and shares: network_pricing.",
    "  - Self-dealing earns nothing: your own, your wallet's, team's or /24's traffic never routes to your node.",
    "  - Tiers rise with paid tenure, uptime, active IPs and reputation (node_tier).",
    "  - Nodes only dial ports 80/443, never private/metadata targets or SMTP/SSH/RDP (network_policy).",
    "",
    "Steps",
    "  1. Store your owner wallet key in a private file (never pass it to a tool or chat):",
    "     umask 077 && printf '%s' \"$WALLET_PRIVATE_KEY_HEX\" > ~/.dominusnode/wallet.key",
    "  2. On the machine whose IP you contribute (Docker), register with the published image",
    "     (official coordinator pins baked in; a plain source build has none and refuses to start):",
    "     sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode",
    "     sudo install -o 1001 -g 1001 -m 600 ~/.dominusnode/wallet.key /etc/dominusnode/wallet.key",
    "     export DN_API_KEY   # your dn_live_ key, from the environment only",
    "     docker run --rm -it -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \\",
    "       -v /etc/dominusnode:/run/dominusnode ghcr.io/0xcircuitbreaker/dominusnode-node register",
    "  3. Run it and keep it running - uptime drives your tier:",
    "     docker run -d --name dominusnode-node --restart unless-stopped \\",
    "       -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro ghcr.io/0xcircuitbreaker/dominusnode-node",
    "  4. Verify with node_list and node_tier; earnings appear in credits_balance.",
    "",
    "Signing flows (node register, withdraw, payout wallet) are not available as tools here; use the",
    "node agent CLI, the DominusNode MCP server or the SDK with a signer key file.",
])


#: Gateway TLS (HTTPS proxy) port: production 8443; self-hosted coordinators publish 8444 by default.
DEFAULT_TLS_PROXY_PORT = 8443


def resolve_gateway(
    proxy_host: Optional[str] = None,
    tls_port: Optional[int] = None,
    http_port: Optional[int] = None,
    insecure: Optional[bool] = None,
    env: Optional[Any] = None,
) -> Dict[str, Any]:
    """Where proxy traffic goes. TLS to the gateway's HTTPS proxy is the default: production
    gateways refuse credentials on plaintext 8080/1080. ``DOMINUSNODE_PROXY_URL=https://host[:port]``
    sets host and TLS port (same variable as the MCP server), ``DOMINUSNODE_PROXY_TLS_PORT`` the TLS
    port, and ``DOMINUSNODE_PROXY_INSECURE=1`` selects plaintext (local development only).

    Returns ``{"proxy_host", "http_port", "gateway_tls"}`` where ``gateway_tls`` is ``False`` or
    ``{"port": n}``, ready for ``DominusNodeClient(gateway_tls=...)``.
    """
    from urllib.parse import urlsplit

    e = os.environ if env is None else env

    def _port(v: Any) -> Optional[int]:
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if 1 <= n <= 65535 else None

    url_host: Optional[str] = None
    url_port: Optional[int] = None
    raw = (e.get("DOMINUSNODE_PROXY_URL") or "").strip()
    if raw:
        u = urlsplit(raw)
        if u.scheme != "https" or not u.hostname:
            raise ValueError("DOMINUSNODE_PROXY_URL must be https://host[:port] (TLS to the gateway)")
        if u.username or u.password:
            raise ValueError("DOMINUSNODE_PROXY_URL must not contain credentials")
        url_host = u.hostname.lower()
        try:
            url_port = _port(u.port) if u.port else DEFAULT_TLS_PROXY_PORT
        except ValueError:
            raise ValueError("DOMINUSNODE_PROXY_URL has an invalid port") from None
    if insecure is None:
        insecure = (e.get("DOMINUSNODE_PROXY_INSECURE") or "").strip() == "1"
    if insecure and raw:
        raise ValueError("DOMINUSNODE_PROXY_URL (TLS) and DOMINUSNODE_PROXY_INSECURE=1 are mutually exclusive")
    tls = _port(tls_port) or url_port or _port(e.get("DOMINUSNODE_PROXY_TLS_PORT")) or DEFAULT_TLS_PROXY_PORT
    return {
        "proxy_host": proxy_host or url_host or (e.get("DOMINUSNODE_PROXY_HOST") or "").strip() or None,
        "http_port": _port(http_port) or _port(e.get("DOMINUSNODE_PROXY_PORT")),
        "gateway_tls": False if insecure else {"port": tls},
    }


def _scrub(text: str, key: Optional[str]) -> str:
    out = scrub_credentials(text)
    if key:
        out = out.replace(key, "[REDACTED]")
    return out


def _opt_int(args: Dict[str, Any], name: str) -> Optional[int]:
    v = args.get(name)
    if v is None:
        return None
    if isinstance(v, bool):
        raise ValueError(f"{name} must be an integer")
    return int(v)


class DominusNodeTools:
    """Dispatches the 19 standard tools to a connected ``DominusNodeClient``."""

    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None,
                 proxy_host: Optional[str] = None, client: Optional[Any] = None,
                 tls_proxy_port: Optional[int] = None, insecure_proxy: Optional[bool] = None) -> None:
        self._api_key = api_key or os.environ.get("DOMINUSNODE_API_KEY") or None
        self._base_url = base_url or os.environ.get("DOMINUSNODE_BASE_URL") or None
        self._gateway = resolve_gateway(proxy_host, tls_proxy_port, None, insecure_proxy)
        self._proxy_host = self._gateway["proxy_host"]
        self._client = client
        self._connected = client is not None
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return "DominusNodeTools(api_key=[REDACTED])"

    __str__ = __repr__

    def _sdk(self) -> Any:
        with self._lock:
            if self._client is None:
                kw: Dict[str, Any] = {}
                if self._base_url:
                    kw["base_url"] = self._base_url
                if self._proxy_host:
                    kw["proxy_host"] = self._proxy_host
                if self._gateway["http_port"]:
                    kw["http_proxy_port"] = self._gateway["http_port"]
                kw["gateway_tls"] = self._gateway["gateway_tls"]
                self._client = DominusNodeClient(**kw)
            if not self._connected:
                if not self._api_key:
                    raise DominusNodeError("DOMINUSNODE_API_KEY is not set")
                self._client.connect_with_key(self._api_key)
                self._connected = True
            return self._client

    # ---- tool implementations -------------------------------------------------
    def _fetch(self, a: Dict[str, Any]) -> Any:
        r = self._sdk().proxy.fetch(
            str(a["url"]), method=str(a.get("method") or "GET").upper(), country=a.get("country"),
            ip_class=a.get("ip_class"), session_id=a.get("session_id"), allow_http=bool(a.get("allow_http", False)))
        body = r.text()
        cut = len(body) > MAX_BODY_CHARS
        return {"status": r.status, "statusText": r.status_text,
                "contentType": (r.headers or {}).get("content-type"),
                "location": (r.headers or {}).get("location"),
                "truncated": bool(r.truncated or cut), "body": body[:MAX_BODY_CHARS]}

    def _proxy_url(self, a: Dict[str, Any]) -> Any:
        c = self._sdk()
        url = c.proxy.build_url(country=a.get("country"), ip_class=a.get("ip_class"), session_id=a.get("session_id"),
                                allow_http=bool(a.get("allow_http", False)), protocol=a.get("protocol") or None)
        user = url.split("://", 1)[1].split(":", 1)[0]
        prefix, rest = url.split("@", 1)[0], url.split("@", 1)[1]
        scheme = prefix.split("://", 1)[0]
        return {"proxyUrl": f"{scheme}://{user}:{_KEY_PLACEHOLDER}@{rest}", "username": user,
                "note": "Replace the placeholder with DOMINUSNODE_API_KEY from your environment."}

    def _dispatch(self, name: str, a: Dict[str, Any]) -> Any:
        if name == "fetch":
            return self._fetch(a)
        if name == "proxy_url":
            return self._proxy_url(a)
        if name == "node_setup_guide":
            return {"guide": NODE_SETUP_GUIDE}
        c = self._sdk()
        if name == "network_policy":
            return c.network.policy()
        if name == "network_pricing":
            return c.network.pricing()
        if name == "network_stats":
            return c.network.stats()
        if name == "balance":
            return c.wallet.get_balance()
        if name == "transactions":
            return c.wallet.get_transactions(limit=_opt_int(a, "limit"), offset=_opt_int(a, "offset"))
        if name == "topup_crypto":
            return c.wallet.top_up_crypto(int(a["amount_cents"]), str(a["currency"]))
        if name == "check_payment":
            return c.wallet.get_crypto_status(str(a["invoice_id"]))
        if name == "usage":
            return c.usage.get(from_=a.get("from"), to=a.get("to"))
        if name == "active_sessions":
            return c.sessions.get_active()
        if name == "report_session":
            return c.sessions.report(str(a["session_id"]), str(a["reason"]))
        if name == "node_list":
            return c.nodes.list(limit=_opt_int(a, "limit"), offset=_opt_int(a, "offset"))
        if name == "node_tier":
            return c.nodes.tier()
        if name == "credits_balance":
            return c.credits.balance()
        if name == "credits_convert":
            return c.credits.convert(str(a["amount_musd"]))
        if name == "payouts_list":
            return c.payouts.list(limit=_opt_int(a, "limit"), offset=_opt_int(a, "offset"))
        if name == "x402_info":
            return c.x402.get_info()
        raise ValueError(f"unknown tool: {name}")

    def call(self, name: str, args: Optional[Dict[str, Any]] = None) -> str:
        """Run a tool by its standard name (prefix optional). Always returns a scrubbed JSON string."""
        if name.startswith(PREFIX):
            name = name[len(PREFIX):]
        args = {k: v for k, v in (args or {}).items() if v is not None}
        try:
            if name not in SPECS_BY_NAME:
                raise ValueError(f"unknown tool: {name}")
            allowed = SPECS_BY_NAME[name]["parameters"]["properties"]
            unknown = [k for k in args if k not in allowed]
            if unknown:
                raise ValueError(f"unexpected argument(s): {', '.join(sorted(unknown))}")
            out = json.dumps(self._dispatch(name, args), default=json_default)
        except Exception as err:  # noqa: BLE001 - every error is returned to the model, scrubbed
            msg = f"{type(err).__name__}: {err}" if not isinstance(err, DominusNodeError) else str(err)
            out = json.dumps({"error": msg})
        return _scrub(out, self._api_key)


def make_tool_callables(tools: DominusNodeTools) -> Dict[str, Callable[..., str]]:
    """``{prefixed_name: fn(**kwargs) -> str}`` for frameworks that take plain functions."""
    def mk(n: str) -> Callable[..., str]:
        def fn(**kwargs: Any) -> str:
            return tools.call(n, kwargs)
        fn.__name__ = PREFIX + n
        fn.__doc__ = SPECS_BY_NAME[n]["description"]
        return fn
    return {PREFIX + n: mk(n) for n in TOOL_NAMES}
