"""Framework-neutral DominusNode v2 tool set, built on the ``dominusnode`` SDK.

Every framework adapter in this package wraps :class:`DominusNodeTools`. The 19
methods named in :data:`TOOL_NAMES` are the standard v2 integration tools. All
HTTP, SSRF/DNS-rebinding checks, gateway username building and validation live
in the SDK; this module only adapts arguments and formats results for an LLM.

Security properties kept here:

- The API key comes from ``DOMINUSNODE_API_KEY`` or constructor config, never
  from a tool argument, and is never returned in a tool output.
- Every result and error string is passed through the SDK's
  ``scrub_credentials`` (dn_live_/dn_test_/dn_node_/dn_proxy_ keys and JWTs).
- Signing flows (node register, withdraw, payout wallet) are not exposed.
"""

import inspect
import json
import os
import re
from typing import Any, Callable, Dict, List, Optional, Tuple, get_type_hints

from dominusnode import (
    DEFAULT_BASE_URL,
    DEFAULT_HTTP_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_SOCKS5_PROXY_PORT,
    DominusNodeClient,
    json_default,
    scrub_credentials,
)

API_KEY_ENV = "DOMINUSNODE_API_KEY"
BASE_URL_ENV = "DOMINUSNODE_BASE_URL"
PROXY_HOST_ENV = "DOMINUSNODE_PROXY_HOST"
PROXY_PORT_ENV = "DOMINUSNODE_PROXY_PORT"
PROXY_URL_ENV = "DOMINUSNODE_PROXY_URL"
PROXY_TLS_PORT_ENV = "DOMINUSNODE_PROXY_TLS_PORT"
PROXY_INSECURE_ENV = "DOMINUSNODE_PROXY_INSECURE"

MAX_BODY_CHARS = 100_000
DEFAULT_BODY_CHARS = 4_000
KEY_PLACEHOLDER = "<DOMINUSNODE_API_KEY>"

TOOL_NAMES: Tuple[str, ...] = (
    "dominusnode_fetch",
    "dominusnode_proxy_url",
    "dominusnode_network_policy",
    "dominusnode_network_pricing",
    "dominusnode_network_stats",
    "dominusnode_balance",
    "dominusnode_transactions",
    "dominusnode_topup_crypto",
    "dominusnode_check_payment",
    "dominusnode_usage",
    "dominusnode_active_sessions",
    "dominusnode_report_session",
    "dominusnode_node_list",
    "dominusnode_node_tier",
    "dominusnode_node_setup_guide",
    "dominusnode_credits_balance",
    "dominusnode_credits_convert",
    "dominusnode_payouts_list",
    "dominusnode_x402_info",
)

NODE_SETUP_GUIDE = """DominusNode relay node setup (earn by contributing an IP)

How earning works
  - Your node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.
  - You earn your tier's share of each paid GB relayed; live prices and shares are in
    dominusnode_network_pricing. Earnings mature before they become available.
  - Self-dealing earns nothing: your own, your wallet's, your team's and your /24's traffic is
    never routed to your node.
  - Tiers rise with paid tenure, uptime, active IPs and reputation (see dominusnode_node_tier).
  - The node floor is fixed: ports 80/443 only, never private/loopback/metadata targets,
    connection metadata only (no payload logging). See dominusnode_network_policy.

Prerequisites
  - A wallet-linked account and a personal dn_live_ API key (not a team key).
  - Docker on the machine whose IP you contribute.
  - IPs in sanctioned countries (Cuba, Iran, North Korea, Russia, Syria) cannot join.

Step 1: Store the owner wallet key in a private file (never pass it as an argument or to an LLM)
  umask 077 && printf '%s' "$WALLET_PRIVATE_KEY_HEX" > ~/.dominusnode/wallet.key

Step 2: Register the node with the published node image (official coordinator pins baked in;
signing happens locally, not through this tool)
  sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode
  sudo install -o 1001 -g 1001 -m 600 ~/.dominusnode/wallet.key /etc/dominusnode/wallet.key
  export DN_API_KEY   # your dn_live_ key, from the environment only
  docker run --rm -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \\
    -v /etc/dominusnode:/run/dominusnode ghcr.io/0xcircuitbreaker/dominusnode-node register
  sudo rm /etc/dominusnode/wallet.key   # not needed after registration
  (Alternatively use the DominusNode MCP server or SDK nodes.register with a signer key file.)

Step 3: Run the node agent on the machine that owns the IP
  docker run -d --name dominusnode-node --restart unless-stopped -e DN_NODE_GB_PER_DAY=5 \\
    -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro ghcr.io/0xcircuitbreaker/dominusnode-node
  A plain source build has no coordinator pins and refuses to start: use the image, or pass
  --coordinator <domain> --trust sha256:<fingerprint> (or DN_NODE_COORD_PINS) for another coordinator.
  Keep it running (the restart policy above): uptime drives your tier.

Step 4: Verify
  dominusnode_node_list shows status and last-seen time once the tunnel is up.
"""


#: Gateway TLS (HTTPS proxy) port: production 8443; self-hosted coordinators publish 8444 by default.
DEFAULT_TLS_PROXY_PORT = 8443


#: credits_convert needs a wallet signature; signing flows are not exposed as LLM tools.
CREDITS_CONVERT_SIGNING_MESSAGE = (
    "Converting credits needs a fresh signature from the wallet linked to this account, so this tool does not convert. Use the DominusNode MCP server (tool dominusnode_credits_convert, with DOMINUSNODE_WALLET_KEY_FILE pointing at a chmod-600 wallet key file) or a DominusNode SDK's credits.convert with a signer key file. Check available credit with credits_balance."
)


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


_JSON_SCALARS = (dict, list, tuple, str, int, float, bool, type(None))


def _json_default(obj: object) -> object:
    """SDK ``json_default`` (Secret -> [REDACTED]) with a ``str`` fallback for anything else."""
    try:
        out = json_default(obj)
    except TypeError:
        return str(obj)
    return out if isinstance(out, _JSON_SCALARS) else str(out)


class DominusNodeTools:
    """The 19 standard DominusNode v2 tools as plain Python methods returning strings.

    Args:
        api_key: Optional config value; defaults to the ``DOMINUSNODE_API_KEY`` env var.
            Never accepted as a tool argument.
        base_url: API base URL (default ``DOMINUSNODE_BASE_URL`` or the public API).
        proxy_host: Gateway host for ``dominusnode_proxy_url``.
        http_proxy_port: Gateway HTTP port.
        client: A pre-built ``dominusnode.DominusNodeClient`` (already connected or not).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
        tls_proxy_port: Optional[int] = None,
        insecure_proxy: Optional[bool] = None,
    ) -> None:
        self.__key = api_key or os.environ.get(API_KEY_ENV) or None
        self._base_url = base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL
        gw = resolve_gateway(proxy_host, tls_proxy_port, http_proxy_port, insecure_proxy)
        self._proxy_host = gw["proxy_host"] or DEFAULT_PROXY_HOST
        self._http_port = gw["http_port"] or DEFAULT_HTTP_PROXY_PORT
        self._gateway_tls = gw["gateway_tls"]
        self._client = client
        self._connected = client is not None and getattr(client, "is_connected", False) is True

    def __repr__(self) -> str:
        return f"DominusNodeTools(configured={'true' if self.__key or self._client else 'false'})"

    __str__ = __repr__

    def __reduce__(self) -> Any:
        raise TypeError("DominusNodeTools cannot be pickled")

    # -- plumbing ---------------------------------------------------------

    def _sdk(self) -> Any:
        if self._client is None:
            self._client = DominusNodeClient(
                base_url=self._base_url,
                proxy_host=self._proxy_host,
                http_proxy_port=self._http_port,
                socks5_proxy_port=DEFAULT_SOCKS5_PROXY_PORT,
                gateway_tls=self._gateway_tls,
            )
        if not self._connected:
            if not self.__key:
                raise RuntimeError(f"DominusNode API key not configured: set {API_KEY_ENV}")
            self._client.connect_with_key(self.__key)
            self._connected = True
        return self._client

    def _clean(self, text: str) -> str:
        out = scrub_credentials(text)
        if self.__key and len(self.__key) >= 8:
            out = out.replace(self.__key, "[REDACTED]")
        return out

    def _ok(self, value: Any) -> str:
        if isinstance(value, str):
            return self._clean(value)
        return self._clean(json.dumps(value, default=_json_default, indent=2, sort_keys=True))

    def _err(self, exc: BaseException) -> str:
        return "Error: " + self._clean(f"{type(exc).__name__}: {exc}")

    def _call(self, fn: Callable[[Any], Any]) -> str:
        try:
            return self._ok(fn(self._sdk()))
        except Exception as exc:  # noqa: BLE001 - every error is returned scrubbed to the model
            return self._err(exc)

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self._connected = False

    # -- 1-2 proxy ---------------------------------------------------------

    def dominusnode_fetch(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        allow_http: bool = False,
        max_chars: int = DEFAULT_BODY_CHARS,
    ) -> str:
        """Fetch a public URL through the DominusNode relay network of contributed exit IPs.

        Billed per GB at the live price from dominusnode_network_pricing. GET or HEAD only, ports
        80/443, private/local targets refused, redirects returned (not followed), 10 MB cap.
        HTTPS is end-to-end encrypted; plaintext http:// needs allow_http=true and is visible to
        the exit node, so never send secrets over it.

        Args:
            url: Absolute https:// (or http:// with allow_http) URL to fetch.
            method: GET or HEAD.
            country: Optional ISO-2 exit country, e.g. US or DE (sanctioned countries refused).
            ip_class: Optional exit class: residential, dc, mobile or masked (masked = cheapest, VPN/anonymizer exits, opt-in).
            session_id: Optional sticky-session id (1-64 letters/digits) to keep the same exit.
            allow_http: Opt in to plaintext http:// (exit-visible).
            max_chars: Maximum body characters returned to you (1-100000, default 4000).
        """

        def run(dn: Any) -> Any:
            limit = max(1, min(int(max_chars), MAX_BODY_CHARS))
            r = dn.proxy.fetch(
                url,
                method=str(method).upper(),
                country=country,
                ip_class=ip_class,
                session_id=session_id,
                allow_http=bool(allow_http),
            )
            body = r.text()
            keep = ("content-type", "content-length", "location", "retry-after", "last-modified")
            return {
                "status": r.status,
                "statusText": r.status_text,
                "headers": {k: v for k, v in r.headers.items() if k.lower() in keep},
                "body": body[:limit],
                "bodyTruncated": bool(r.truncated) or len(body) > limit,
            }

        return self._call(run)

    def dominusnode_proxy_url(
        self,
        country: Optional[str] = None,
        ip_class: Optional[str] = None,
        session_id: Optional[str] = None,
        allow_http: bool = False,
    ) -> str:
        """Build the gateway proxy URL for routing your own HTTP client through the relay network.

        Routing flags go in the proxy username (hyphenated, e.g. country-US-class-dc); the API key
        goes in the password. The key is NOT returned: the URL contains a placeholder that your
        runtime substitutes from the DOMINUSNODE_API_KEY environment variable.

        Args:
            country: Optional ISO-2 exit country (sanctioned countries refused).
            ip_class: Optional exit class: residential, dc, mobile or masked (masked = cheapest, VPN/anonymizer exits, opt-in).
            session_id: Optional sticky-session id (1-64 letters/digits).
            allow_http: Allow plaintext http:// targets (visible to the exit node).
        """

        def run(dn: Any) -> Any:
            user = dn.proxy.build_username(
                country=country, ip_class=ip_class, session_id=session_id, allow_http=bool(allow_http)
            )
            return {
                "username": user,
                "proxyUrl": (
                    f"https://{user}:{KEY_PLACEHOLDER}@{self._proxy_host}:{self._gateway_tls['port']}"
                    if self._gateway_tls
                    else f"http://{user}:{KEY_PLACEHOLDER}@{self._proxy_host}:{self._http_port}"
                ),
                "note": f"Replace {KEY_PLACEHOLDER} with the value of ${API_KEY_ENV}; never log the real URL.",
            }

        return self._call(run)

    # -- 3-5 network -------------------------------------------------------

    def dominusnode_network_policy(self) -> str:
        """Show the relay network policy: allowed ports, blocked targets, sanctioned countries, logging rules."""
        return self._call(lambda dn: dn.network.policy())

    def dominusnode_network_pricing(self) -> str:
        """Show live per-GB prices by IP class (in µUSD; 1 USD = 1,000,000 µUSD) and node earning shares.

        Always use this instead of assuming prices.
        """
        return self._call(lambda dn: dn.network.pricing())

    def dominusnode_network_stats(self) -> str:
        """Show relay network statistics: online nodes, countries and IP classes available."""
        return self._call(lambda dn: dn.network.stats())

    # -- 6-9 wallet --------------------------------------------------------

    def dominusnode_balance(self) -> str:
        """Show your prepaid wallet balance used to pay for relay traffic."""
        return self._call(lambda dn: dn.wallet.get_balance())

    def dominusnode_transactions(self, limit: int = 20, offset: int = 0) -> str:
        """List recent wallet transactions (top-ups and usage charges).

        Args:
            limit: Number of transactions to return (1-100).
            offset: Number of transactions to skip.
        """
        return self._call(lambda dn: dn.wallet.get_transactions(limit=limit, offset=offset))

    def dominusnode_topup_crypto(self, amount_cents: int, currency: str) -> str:
        """Create a crypto invoice to top up your wallet ($10-$1,000).

        Returns a payment address/invoice; check it with dominusnode_check_payment.

        Args:
            amount_cents: Amount in US cents, 1000 to 100000.
            currency: One of btc, eth, ltc, xmr, zec, usdc, sol, usdt, dai, bnb, link.
        """
        return self._call(lambda dn: dn.wallet.top_up_crypto(amount_cents, currency))

    def dominusnode_check_payment(self, invoice_id: str) -> str:
        """Check the status of a crypto top-up invoice.

        Args:
            invoice_id: Invoice UUID returned by dominusnode_topup_crypto.
        """
        return self._call(lambda dn: dn.wallet.get_crypto_status(invoice_id))

    # -- 10-12 usage and sessions -----------------------------------------

    def dominusnode_usage(self, since: Optional[str] = None, until: Optional[str] = None) -> str:
        """Summarise your relay bandwidth usage and cost.

        Args:
            since: Optional ISO-8601 start date/time.
            until: Optional ISO-8601 end date/time.
        """
        return self._call(lambda dn: dn.usage.get(from_=since, to=until))

    def dominusnode_active_sessions(self) -> str:
        """List your active proxy sessions (id, start time, status; exit IPs are never shown)."""
        return self._call(lambda dn: dn.sessions.get_active())

    def dominusnode_report_session(self, session_id: str, reason: str) -> str:
        """Report a bad relay session so the exit node's reputation is updated.

        Args:
            session_id: Session UUID from dominusnode_active_sessions.
            reason: One of blocked, captcha, rate_limited, slow, bad_content, other.
        """
        return self._call(lambda dn: dn.sessions.report(session_id, reason))

    # -- 13-15 nodes -------------------------------------------------------

    def dominusnode_node_list(self, limit: int = 50, offset: int = 0) -> str:
        """List the relay nodes you contribute (status, class, last seen).

        Args:
            limit: Number of nodes to return (1-500).
            offset: Number of nodes to skip.
        """
        return self._call(lambda dn: dn.nodes.list(limit=limit, offset=offset))

    def dominusnode_node_tier(self) -> str:
        """Show your node-operator tier, earning share and progress to the next tier."""
        return self._call(lambda dn: dn.nodes.tier())

    def dominusnode_node_setup_guide(self) -> str:
        """Explain how to earn by contributing an IP: run the DominusNode node agent, step by step."""
        return self._ok(NODE_SETUP_GUIDE)

    # -- 16-18 earnings ----------------------------------------------------

    def dominusnode_credits_balance(self) -> str:
        """Show node-operator credits earned by relaying traffic (µUSD; pending and available)."""
        return self._call(lambda dn: dn.credits.balance())

    def dominusnode_credits_convert(self, amount_musd: str, idempotency_key: Optional[str] = None) -> str:
        """Explain how to convert earned credits into wallet balance (needs a wallet signature, so not done here).

        Args:
            amount_musd: Amount in µUSD as a digit string (10000 = $0.01; min 10000).
            idempotency_key: Optional key from a previous attempt, to retry safely.
        """
        return self._ok({"status": "signing_required", "message": CREDITS_CONVERT_SIGNING_MESSAGE})

    def dominusnode_payouts_list(self, limit: int = 20, offset: int = 0) -> str:
        """List your on-chain payouts (withdrawals of earned credits). Withdrawing needs a signer, not this tool.

        Args:
            limit: Number of payouts to return (1-200).
            offset: Number of payouts to skip.
        """
        return self._call(lambda dn: dn.payouts.list(limit=limit, offset=offset))

    # -- 19 x402 -----------------------------------------------------------

    def dominusnode_x402_info(self) -> str:
        """Show x402 (HTTP 402 micropayment) support details for paying per request."""
        return self._call(lambda dn: dn.x402.get_info())

    # -- helpers for adapters ---------------------------------------------

    def tool_functions(self) -> List[Callable[..., str]]:
        """The 19 bound tool methods, in standard order."""
        return [getattr(self, n) for n in TOOL_NAMES]


# ---------------------------------------------------------------------------
# Docstring helpers shared by adapters
# ---------------------------------------------------------------------------

_ARGS_RE = re.compile(r"^\s{4,}(\w+):\s*(.+)$")


def describe(fn: Callable[..., Any]) -> str:
    """Tool description: the docstring without its Args section."""
    doc = inspect.getdoc(fn) or ""
    return doc.split("\nArgs:")[0].strip()


def arg_docs(fn: Callable[..., Any]) -> Dict[str, str]:
    doc = fn.__doc__ or ""
    if "Args:" not in doc:
        return {}
    out: Dict[str, str] = {}
    for line in doc.split("Args:", 1)[1].splitlines():
        m = _ARGS_RE.match(line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def args_model(fn: Callable[..., Any], model_name: str) -> Any:
    """Build a pydantic model for a tool method's arguments (for schema-driven frameworks)."""
    from pydantic import Field, create_model

    docs = arg_docs(fn)
    hints = get_type_hints(fn)
    fields: Dict[str, Any] = {}
    for name, p in inspect.signature(fn).parameters.items():
        ann = hints.get(name, str)
        default = ... if p.default is inspect.Parameter.empty else p.default
        fields[name] = (ann, Field(default, description=docs.get(name, name)))
    return create_model(model_name, **fields)
