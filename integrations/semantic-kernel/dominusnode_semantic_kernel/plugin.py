"""Semantic Kernel plugin for the DominusNode v2 standard tool set.

Usage::

    from semantic_kernel import Kernel
    from dominusnode_semantic_kernel import DominusNodePlugin

    kernel = Kernel()
    kernel.add_plugin(DominusNodePlugin(), plugin_name="dominusnode")
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from semantic_kernel.functions import kernel_function

from dominusnode_semantic_kernel._core import TOOL_SPECS, DominusNodeToolkit


def _d(name: str) -> str:
    return TOOL_SPECS[name]["description"]


class DominusNodePlugin:
    """The 19 DominusNode tools as Semantic Kernel functions (results are JSON strings).

    The API key is read from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` argument);
    it is never a function parameter and never appears in a result.
    """

    def __init__(self, api_key: Optional[str] = None, toolkit: Optional[DominusNodeToolkit] = None, **kwargs: Any) -> None:
        self._toolkit = toolkit or DominusNodeToolkit(api_key=api_key, **kwargs)

    def __repr__(self) -> str:
        return "DominusNodePlugin()"

    def _call(self, name: str, **kwargs: Any) -> str:
        # SK passes "" / 0 for omitted optional values; treat them as "not given".
        args = {k: v for k, v in kwargs.items() if v is not None and v != "" and not (k in ("limit", "offset") and v == 0)}
        return self._toolkit.call_json(name, args)

    @kernel_function(name="fetch", description=_d("fetch"))
    def fetch(
        self,
        url: Annotated[str, "Target URL (https://...; http:// only with allow_http)"],
        method: Annotated[str, "GET or HEAD"] = "GET",
        country: Annotated[str, "ISO 3166-1 alpha-2 exit country; sanctioned countries refused"] = "",
        ip_class: Annotated[str, "residential, dc, mobile or masked (masked = cheapest, VPN/anonymizer exits, opt-in) (prices in network_pricing)"] = "",
        session_id: Annotated[str, "Sticky session id (1-64 letters/digits)"] = "",
        allow_http: Annotated[bool, "Opt in to plaintext http://; visible to the exit node"] = False,
        max_chars: Annotated[int, "Maximum body characters returned"] = 4000,
    ) -> Annotated[str, "JSON: status, headers, body"]:
        return self._call("fetch", url=url, method=method, country=country, ip_class=ip_class,
                          session_id=session_id, allow_http=allow_http, max_chars=max_chars)

    @kernel_function(name="proxy_url", description=_d("proxy_url"))
    def proxy_url(
        self,
        country: Annotated[str, "ISO 3166-1 alpha-2 exit country"] = "",
        ip_class: Annotated[str, "residential, dc, mobile or masked (masked = cheapest, VPN/anonymizer exits, opt-in)"] = "",
        session_id: Annotated[str, "Sticky session id"] = "",
        allow_http: Annotated[bool, "Add the allowhttp-1 flag (plaintext is exit-visible)"] = False,
        protocol: Annotated[str, "http or socks5"] = "http",
    ) -> Annotated[str, "JSON: username and URL with a key placeholder"]:
        return self._call("proxy_url", country=country, ip_class=ip_class, session_id=session_id,
                          allow_http=allow_http, protocol=protocol)

    @kernel_function(name="network_policy", description=_d("network_policy"))
    def network_policy(self) -> Annotated[str, "JSON policy"]:
        return self._call("network_policy")

    @kernel_function(name="network_pricing", description=_d("network_pricing"))
    def network_pricing(self) -> Annotated[str, "JSON pricing"]:
        return self._call("network_pricing")

    @kernel_function(name="network_stats", description=_d("network_stats"))
    def network_stats(self) -> Annotated[str, "JSON stats"]:
        return self._call("network_stats")

    @kernel_function(name="balance", description=_d("balance"))
    def balance(self) -> Annotated[str, "JSON balance"]:
        return self._call("balance")

    @kernel_function(name="transactions", description=_d("transactions"))
    def transactions(
        self,
        limit: Annotated[int, "Maximum rows"] = 20,
        offset: Annotated[int, "Rows to skip"] = 0,
    ) -> Annotated[str, "JSON transactions"]:
        return self._call("transactions", limit=limit, offset=offset)

    @kernel_function(name="topup_crypto", description=_d("topup_crypto"))
    def topup_crypto(
        self,
        amount_cents: Annotated[int, "Amount in US cents (1000-100000)"],
        currency: Annotated[str, "Crypto currency code, e.g. usdc, btc"],
    ) -> Annotated[str, "JSON invoice"]:
        return self._call("topup_crypto", amount_cents=amount_cents, currency=currency)

    @kernel_function(name="check_payment", description=_d("check_payment"))
    def check_payment(self, invoice_id: Annotated[str, "Invoice UUID from topup_crypto"]) -> Annotated[str, "JSON status"]:
        return self._call("check_payment", invoice_id=invoice_id)

    @kernel_function(name="usage", description=_d("usage"))
    def usage(
        self,
        since: Annotated[str, "Start, ISO 8601"] = "",
        until: Annotated[str, "End, ISO 8601"] = "",
        limit: Annotated[int, "Maximum records"] = 20,
    ) -> Annotated[str, "JSON usage"]:
        return self._call("usage", since=since, until=until, limit=limit)

    @kernel_function(name="active_sessions", description=_d("active_sessions"))
    def active_sessions(self) -> Annotated[str, "JSON sessions"]:
        return self._call("active_sessions")

    @kernel_function(name="report_session", description=_d("report_session"))
    def report_session(
        self,
        session_id: Annotated[str, "Session UUID"],
        reason: Annotated[str, "blocked, captcha, rate_limited, slow, bad_content or other"],
    ) -> Annotated[str, "JSON report receipt"]:
        return self._call("report_session", session_id=session_id, reason=reason)

    @kernel_function(name="node_list", description=_d("node_list"))
    def node_list(
        self,
        limit: Annotated[int, "Maximum nodes (1-500)"] = 0,
        offset: Annotated[int, "Rows to skip"] = 0,
    ) -> Annotated[str, "JSON nodes"]:
        return self._call("node_list", limit=limit, offset=offset)

    @kernel_function(name="node_tier", description=_d("node_tier"))
    def node_tier(self) -> Annotated[str, "JSON tier"]:
        return self._call("node_tier")

    @kernel_function(name="node_setup_guide", description=_d("node_setup_guide"))
    def node_setup_guide(self) -> Annotated[str, "JSON guide"]:
        return self._call("node_setup_guide")

    @kernel_function(name="credits_balance", description=_d("credits_balance"))
    def credits_balance(self) -> Annotated[str, "JSON credits"]:
        return self._call("credits_balance")

    @kernel_function(name="credits_convert", description=_d("credits_convert"))
    def credits_convert(
        self,
        amount_musd: Annotated[str, "Micro-USD digit string (1000000 = $1; min 10000)"],
        idempotency_key: Annotated[str, "Optional key for a safe retry"] = "",
    ) -> Annotated[str, "JSON conversion"]:
        return self._call("credits_convert", amount_musd=amount_musd, idempotency_key=idempotency_key)

    @kernel_function(name="payouts_list", description=_d("payouts_list"))
    def payouts_list(
        self,
        limit: Annotated[int, "Maximum rows"] = 0,
        offset: Annotated[int, "Rows to skip"] = 0,
    ) -> Annotated[str, "JSON payouts"]:
        return self._call("payouts_list", limit=limit, offset=offset)

    @kernel_function(name="x402_info", description=_d("x402_info"))
    def x402_info(self) -> Annotated[str, "JSON x402 info"]:
        return self._call("x402_info")
