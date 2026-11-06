"""DominusNode v2 standard tool set (19 tools), built on the ``dominusnode`` SDK.

Framework adapters in this package wrap :class:`DominusNodeToolkit` and
:data:`TOOL_SPECS`. All HTTP, SSRF/DNS-rebinding checks, proxy tunnelling,
validation and credential scrubbing live in the SDK; this module only maps
tool calls to SDK calls and makes every result safe to hand to a model.

The API key comes from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` config
argument). It is never a tool argument and never appears in tool output.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

from dominusnode import DominusNodeClient, json_default, scrub_credentials

TOOL_NAMES: List[str] = [
    "fetch",
    "proxy_url",
    "network_policy",
    "network_pricing",
    "network_stats",
    "balance",
    "transactions",
    "topup_crypto",
    "check_payment",
    "usage",
    "active_sessions",
    "report_session",
    "node_list",
    "node_tier",
    "node_setup_guide",
    "credits_balance",
    "credits_convert",
    "payouts_list",
    "x402_info",
]

DEFAULT_MAX_CHARS = 4000
_MAX_CHARS_CAP = 100_000
_KEY_PLACEHOLDER = "<DOMINUSNODE_API_KEY>"
_SECRET_RE = re.compile(r"dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+")

NODE_SETUP_GUIDE: Dict[str, Any] = {
    "summary": (
        "Earn credits by contributing an IP to the DominusNode relay network. A node agent on your "
        "machine dials OUT to the gateway (no inbound ports) and relays other agents' GET/HEAD "
        "traffic on ports 80/443 only. You earn your tier's share of each paid GB relayed; live "
        "prices and shares come from network_pricing, tier progress from node_tier."
    ),
    "rules": [
        "Self-dealing earns nothing: your own, your wallet's, your team's or your /24's traffic is never routed to your node.",
        "Node floor: ports 80/443 only, never private/loopback/metadata targets, never SMTP/SSH/RDP, metadata-only logging (see network_policy).",
        "IPs in sanctioned countries (CU, IR, KP, RU, SY) cannot join.",
        "Tiers rise with paid tenure, uptime, distinct active IPs and reputation.",
    ],
    "prerequisites": [
        "A wallet-linked account and a dn_live_ API key (not a team key).",
        "Node.js >= 18 and git on the machine whose IP you contribute.",
    ],
    "steps": [
        "1. Store the owner wallet private key in a 0600 file, e.g. ~/.dominusnode/wallet.key (never pass it as an argument).",
        "2. Register the node (signing happens locally, not through this tool set): either the DominusNode MCP server "
        "(DOMINUSNODE_WALLET_KEY_FILE set, tool dominusnode_node_register) or the node agent CLI: "
        "git clone https://github.com/0xcircuitbreaker/DomiNode.git && cd DomiNode && npm ci && "
        "npm run build -w @dominusnode/shared -w @dominusnode/node-agent && "
        "node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key "
        "(API key from the DN_API_KEY environment variable).",
        "3. Run the agent on the machine that owns the IP: node packages/node-agent/dist/src/main.js run "
        "--key-file ~/.dominusnode/node.json (optional limits: --ports 443 --max-streams 32 --gb-per-day 5). "
        "Keep it running (systemd, pm2 or a container restart policy); uptime drives your tier.",
        "4. Verify with node_list, then watch earnings with credits_balance and convert them with credits_convert.",
    ],
}


def _redact_str(s: str, key: Optional[str]) -> str:
    if key:
        s = s.replace(key, "[REDACTED]").replace(quote(key, safe=""), "[REDACTED]")
    return scrub_credentials(s)


def _sanitize(obj: Any, key: Optional[str], depth: int = 0) -> Any:
    """Make a result JSON-safe and strip any credential from every string in it."""
    if depth > 32:
        return "[TRUNCATED]"
    if isinstance(obj, str):
        return _redact_str(obj, key)
    if isinstance(obj, dict):
        return {_redact_str(str(k), key): _sanitize(v, key, depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v, key, depth + 1) for v in obj]
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    try:
        plain = json_default(obj)
    except TypeError:
        return _redact_str(str(obj), key)
    if plain is obj or not isinstance(plain, (str, dict, list, tuple, bool, int, float, type(None))):
        return _redact_str(str(plain), key)
    return _sanitize(plain, key, depth + 1)


class DominusNodeToolkit:
    """The 19 standard DominusNode tools as plain methods returning JSON-safe dicts.

    Every method catches errors and returns ``{"error": "<scrubbed message>"}``
    instead of raising, so a model never sees a stack trace or a credential.

    Args:
        api_key: DominusNode API key. Defaults to ``DOMINUSNODE_API_KEY``.
        base_url: API base URL. Defaults to ``DOMINUSNODE_BASE_URL`` / ``DOMINUSNODE_API_URL``
            or the SDK default.
        proxy_host: Gateway host. Defaults to ``DOMINUSNODE_PROXY_HOST`` or the SDK default.
        client: A pre-built ``dominusnode.DominusNodeClient`` (advanced/testing).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        client: Any = None,
    ) -> None:
        self.__api_key = api_key or os.environ.get("DOMINUSNODE_API_KEY") or None
        self._base_url = base_url or os.environ.get("DOMINUSNODE_BASE_URL") or os.environ.get("DOMINUSNODE_API_URL")
        self._proxy_host = proxy_host or os.environ.get("DOMINUSNODE_PROXY_HOST")
        self._client = client
        self._connected = False

    def __repr__(self) -> str:
        return f"DominusNodeToolkit(api_key={'[REDACTED]' if self.__api_key else None})"

    __str__ = __repr__

    # ------------------------------------------------------------------ plumbing
    def _sdk(self) -> Any:
        if self._client is None:
            kwargs: Dict[str, Any] = {}
            if self._base_url:
                kwargs["base_url"] = self._base_url
            if self._proxy_host:
                kwargs["proxy_host"] = self._proxy_host
            self._client = DominusNodeClient(**kwargs)
        if not self._connected:
            if not self.__api_key:
                raise RuntimeError("DOMINUSNODE_API_KEY is not set")
            self._client.connect_with_key(self.__api_key)
            self._connected = True
        return self._client

    def _run(self, fn: Callable[[Any], Any]) -> Dict[str, Any]:
        try:
            result = fn(self._sdk())
        except Exception as exc:  # noqa: BLE001 - every error is reported to the model, scrubbed
            msg = str(exc) or type(exc).__name__
            return {"error": _redact_str(msg, self.__api_key)}
        out = _sanitize(result, self.__api_key)
        return out if isinstance(out, dict) else {"result": out}

    def close(self) -> None:
        """Disconnect the SDK client and drop the stored credentials."""
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # noqa: BLE001
                pass
        self._client = None
        self._connected = False

    def call(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Dispatch a tool by its standard name with a dict of arguments."""
        if name not in TOOL_NAMES:
            return {"error": f"unknown tool: {name}"}
        args = dict(arguments or {})
        allowed = set(TOOL_SPECS[name]["parameters"]["properties"])
        unknown = sorted(set(args) - allowed)
        if unknown:
            return {"error": f"unknown argument(s): {', '.join(unknown)}"}
        try:
            return getattr(self, name)(**args)
        except TypeError as exc:
            return {"error": _redact_str(str(exc), self.__api_key)}

    def call_json(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        return json.dumps(self.call(name, arguments), ensure_ascii=False)

    # ------------------------------------------------------------------ 1-2 proxy
    def fetch(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        allow_http: bool = False,
        max_chars: int = DEFAULT_MAX_CHARS,
    ) -> Dict[str, Any]:
        def go(c: Any) -> Dict[str, Any]:
            res = c.proxy.fetch(
                url,
                method=str(method).upper(),
                country=country or None,
                ip_class=ip_class or None,
                session_id=session_id or None,
                allow_http=bool(allow_http),
            )
            limit = max(0, min(int(max_chars or DEFAULT_MAX_CHARS), _MAX_CHARS_CAP))
            text = res.text()
            return {
                "status": res.status,
                "statusText": res.status_text,
                "headers": dict(res.headers),
                "body": text[:limit],
                "bodyTruncated": bool(res.truncated) or len(text) > limit,
            }

        return self._run(go)

    def proxy_url(
        self,
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        allow_http: bool = False,
        protocol: str = "http",
    ) -> Dict[str, Any]:
        def go(c: Any) -> Dict[str, Any]:
            opts = dict(
                country=country or None,
                ip_class=ip_class or None,
                session_id=session_id or None,
                allow_http=bool(allow_http),
            )
            username = c.proxy.build_username(**opts)
            url = c.proxy.build_url(protocol=protocol, **opts)
            m = re.match(r"^([a-z0-9]+://[^:@/]+:)[^@]*(@.*)$", url)
            masked = f"{m.group(1)}{_KEY_PLACEHOLDER}{m.group(2)}" if m else ""
            return {
                "username": username,
                "url": masked,
                "note": f"Replace {_KEY_PLACEHOLDER} with your API key from the DOMINUSNODE_API_KEY "
                "environment variable. The key goes in the proxy PASSWORD, routing flags in the USERNAME.",
            }

        return self._run(go)

    # ------------------------------------------------------------------ 3-5 network
    def network_policy(self) -> Dict[str, Any]:
        return self._run(lambda c: c.network.policy())

    def network_pricing(self) -> Dict[str, Any]:
        return self._run(lambda c: c.network.pricing())

    def network_stats(self) -> Dict[str, Any]:
        return self._run(lambda c: c.network.stats())

    # ------------------------------------------------------------------ 6-9 wallet
    def balance(self) -> Dict[str, Any]:
        return self._run(lambda c: c.wallet.get_balance())

    def transactions(self, limit: Optional[int] = 20, offset: Optional[int] = None) -> Dict[str, Any]:
        return self._run(lambda c: c.wallet.get_transactions(limit=limit, offset=offset))

    def topup_crypto(self, amount_cents: int, currency: str) -> Dict[str, Any]:
        return self._run(lambda c: c.wallet.top_up_crypto(amount_cents, currency))

    def check_payment(self, invoice_id: str) -> Dict[str, Any]:
        return self._run(lambda c: c.wallet.get_crypto_status(invoice_id))

    # ------------------------------------------------------------------ 10-12 usage/sessions
    def usage(self, since: Optional[str] = None, until: Optional[str] = None, limit: Optional[int] = 20) -> Dict[str, Any]:
        return self._run(lambda c: c.usage.get(from_=since or None, to=until or None, limit=limit))

    def active_sessions(self) -> Dict[str, Any]:
        return self._run(lambda c: c.sessions.get_active())

    def report_session(self, session_id: str, reason: str) -> Dict[str, Any]:
        return self._run(lambda c: c.sessions.report(session_id, reason))

    # ------------------------------------------------------------------ 13-15 nodes
    def node_list(self, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        return self._run(lambda c: c.nodes.list(limit=limit, offset=offset))

    def node_tier(self) -> Dict[str, Any]:
        return self._run(lambda c: c.nodes.tier())

    def node_setup_guide(self) -> Dict[str, Any]:
        return json.loads(json.dumps(NODE_SETUP_GUIDE))

    # ------------------------------------------------------------------ 16-19 credits/payouts/x402
    def credits_balance(self) -> Dict[str, Any]:
        return self._run(lambda c: c.credits.balance())

    def credits_convert(self, amount_musd: str, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        return self._run(lambda c: c.credits.convert(str(amount_musd), idempotency_key=idempotency_key or None))

    def payouts_list(self, limit: Optional[int] = None, offset: Optional[int] = None) -> Dict[str, Any]:
        return self._run(lambda c: c.payouts.list(limit=limit, offset=offset))

    def x402_info(self) -> Dict[str, Any]:
        return self._run(lambda c: c.x402.get_info())


# ---------------------------------------------------------------------- tool specs
def _obj(props: Dict[str, Any], required: Optional[List[str]] = None) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


_COUNTRY = {"type": "string", "description": "ISO 3166-1 alpha-2 exit country, e.g. US, DE. Sanctioned countries (CU, IR, KP, RU, SY) are refused."}
_IP_CLASS = {"type": "string", "enum": ["residential", "dc", "mobile"], "description": "Exit IP class. Omit to let the relay choose. Prices differ by class: see network_pricing."}
_SESSION = {"type": "string", "description": "Sticky session id (1-64 letters/digits) to keep the same exit node across requests."}
_ALLOW_HTTP = {"type": "boolean", "default": False, "description": "Opt in to plaintext http:// targets. Plaintext traffic is visible to the exit node; leave false for https."}
_LIMIT = {"type": "integer", "minimum": 1, "maximum": 200, "description": "Maximum rows to return."}
_OFFSET = {"type": "integer", "minimum": 0, "description": "Rows to skip (pagination)."}

TOOL_SPECS: Dict[str, Dict[str, Any]] = {
    "fetch": {
        "description": (
            "Fetch a URL through the DominusNode relay network (agent-contributed exit nodes). GET or HEAD only, "
            "ports 80/443, no redirects followed, private/internal targets refused. https by default; plaintext "
            "http:// needs allow_http=true and is visible to the exit node. Billed per GB from your prepaid wallet "
            "at the live rate in network_pricing. Returns status, headers and the body (truncated to max_chars)."
        ),
        "parameters": _obj(
            {
                "url": {"type": "string", "description": "Target URL (https://... ; http:// only with allow_http)."},
                "method": {"type": "string", "enum": ["GET", "HEAD"], "default": "GET", "description": "HTTP method."},
                "country": _COUNTRY,
                "ip_class": _IP_CLASS,
                "session_id": _SESSION,
                "allow_http": _ALLOW_HTTP,
                "max_chars": {"type": "integer", "minimum": 1, "maximum": _MAX_CHARS_CAP, "default": DEFAULT_MAX_CHARS, "description": "Maximum body characters returned."},
            },
            ["url"],
        ),
    },
    "proxy_url": {
        "description": (
            "Build a relay proxy URL for use with any HTTP or SOCKS5 client. Routing flags (country, class, sticky "
            "session, allowhttp) go in the proxy username; the account credential is shown only as the placeholder "
            "<DOMINUSNODE_API_KEY>, which the caller fills from its own environment."
        ),
        "parameters": _obj(
            {
                "country": _COUNTRY,
                "ip_class": _IP_CLASS,
                "session_id": _SESSION,
                "allow_http": _ALLOW_HTTP,
                "protocol": {"type": "string", "enum": ["http", "socks5"], "default": "http", "description": "Proxy protocol."},
            }
        ),
    },
    "network_policy": {
        "description": "Relay network policy: allowed ports and methods, blocked targets and countries, node rules. Read before routing unusual traffic.",
        "parameters": _obj({}),
    },
    "network_pricing": {
        "description": "Live per-GB relay prices by IP class (in micro-USD) and the node operator earning shares by tier. The only source of prices: never assume a price.",
        "parameters": _obj({}),
    },
    "network_stats": {
        "description": "Relay network size: online nodes by IP class and by country. Use it to pick a country/class with capacity.",
        "parameters": _obj({}),
    },
    "balance": {
        "description": "Prepaid wallet balance (cents) that pays for relay traffic.",
        "parameters": _obj({}),
    },
    "transactions": {
        "description": "Recent prepaid wallet transactions (top-ups and traffic charges).",
        "parameters": _obj({"limit": _LIMIT, "offset": _OFFSET}),
    },
    "topup_crypto": {
        "description": "Create a crypto invoice to top up the prepaid wallet ($10-$1,000). Returns a payment address/link; poll check_payment with the invoice id.",
        "parameters": _obj(
            {
                "amount_cents": {"type": "integer", "minimum": 1000, "maximum": 100000, "description": "Amount in US cents (1000 = $10)."},
                "currency": {"type": "string", "description": "Crypto currency code, e.g. usdc, usdt, btc, eth, sol."},
            },
            ["amount_cents", "currency"],
        ),
    },
    "check_payment": {
        "description": "Status of a crypto top-up invoice created by topup_crypto.",
        "parameters": _obj({"invoice_id": {"type": "string", "description": "Invoice UUID from topup_crypto."}}, ["invoice_id"]),
    },
    "usage": {
        "description": "Relay traffic usage summary (bytes, cost, requests) with recent records for a date range.",
        "parameters": _obj(
            {
                "since": {"type": "string", "description": "Start, ISO 8601 (e.g. 2026-01-01). Default: server default period."},
                "until": {"type": "string", "description": "End, ISO 8601."},
                "limit": _LIMIT,
            }
        ),
    },
    "active_sessions": {
        "description": "Currently active relay sessions (id, start time, status).",
        "parameters": _obj({}),
    },
    "report_session": {
        "description": "Report a bad relay session (blocked, captcha, rate_limited, slow, bad_content, other) so the exit node's reputation is adjusted and it is avoided.",
        "parameters": _obj(
            {
                "session_id": {"type": "string", "description": "Session UUID (from active_sessions)."},
                "reason": {"type": "string", "enum": ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"], "description": "What went wrong."},
            },
            ["session_id", "reason"],
        ),
    },
    "node_list": {
        "description": "Your own relay nodes (the IPs you contribute to earn credits): status, class, country, reputation, last seen.",
        "parameters": _obj({"limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Maximum nodes."}, "offset": _OFFSET}),
    },
    "node_tier": {
        "description": "Your node operator tier, earning share and progress toward the next tier.",
        "parameters": _obj({}),
    },
    "node_setup_guide": {
        "description": "How to earn by contributing an IP: steps to register and run the DominusNode node agent, and the earning rules.",
        "parameters": _obj({}),
    },
    "credits_balance": {
        "description": "Node operator earnings in micro-USD: pending, available and frozen credits, tier and payout status.",
        "parameters": _obj({}),
    },
    "credits_convert": {
        "description": "Convert available earned credits (micro-USD) into prepaid wallet balance to pay for relay traffic. Retry with the returned idempotency key.",
        "parameters": _obj(
            {
                "amount_musd": {"type": "string", "description": "Amount in micro-USD as a digit string (1000000 = $1; min 10000)."},
                "idempotency_key": {"type": "string", "description": "Optional key to make a retry safe."},
            },
            ["amount_musd"],
        ),
    },
    "payouts_list": {
        "description": "Payouts of earned credits to your payout wallet.",
        "parameters": _obj({"limit": _LIMIT, "offset": _OFFSET}),
    },
    "x402_info": {
        "description": "x402 HTTP micropayment support: facilitators, networks, currencies and server-reported pricing.",
        "parameters": _obj({}),
    },
}

assert list(TOOL_SPECS) == TOOL_NAMES
