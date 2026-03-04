"""Dominus Node LlamaIndex ToolSpec -- exposes all 24 functions as LlamaIndex tools.

The :class:`DominusNodeToolSpec` subclasses
:class:`llama_index.core.tools.tool_spec.base.BaseToolSpec` and delegates
every method to an internal :class:`DominusNodeClient`.  This allows
LlamaIndex agents to call Dominus Node proxy, wallet, agentic wallet, team,
and PayPal tools through a unified interface.

Example::

    from dominusnode_llamaindex import DominusNodeToolSpec

    spec = DominusNodeToolSpec(api_key="dn_live_abc123")
    tools = spec.to_tool_list()

    # Use with a LlamaIndex agent
    from llama_index.core.agent import ReActAgent
    agent = ReActAgent.from_tools(tools, llm=llm)
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from llama_index.core.tools.tool_spec.base import BaseToolSpec

from .tools import DominusNodeClient


class DominusNodeToolSpec(BaseToolSpec):
    """LlamaIndex tool spec for the Dominus Node rotating proxy service.

    Provides 25 tools covering proxy operations, wallet management,
    agentic wallets, team management, payment top-ups, and x402 info.

    Args:
        api_key: Dominus Node API key (``dn_live_...``).  Falls back to the
            ``DOMINUSNODE_API_KEY`` environment variable.
        base_url: Base URL for the Dominus Node REST API.  Falls back to
            ``DOMINUSNODE_BASE_URL`` or ``https://api.dominusnode.com``.
        proxy_host: Hostname of the Dominus Node proxy gateway.  Falls back
            to ``DOMINUSNODE_PROXY_HOST`` or ``proxy.dominusnode.com``.
        proxy_port: Port of the Dominus Node proxy gateway.  Falls back to
            ``DOMINUSNODE_PROXY_PORT`` or ``8080``.
    """

    spec_functions: List[str] = [
        "proxied_fetch",
        "check_balance",
        "check_usage",
        "get_proxy_config",
        "list_sessions",
        "create_agentic_wallet",
        "fund_agentic_wallet",
        "agentic_wallet_balance",
        "list_agentic_wallets",
        "agentic_transactions",
        "freeze_agentic_wallet",
        "unfreeze_agentic_wallet",
        "delete_agentic_wallet",
        "update_wallet_policy",
        "create_team",
        "list_teams",
        "team_details",
        "team_fund",
        "team_create_key",
        "team_usage",
        "update_team",
        "update_team_member_role",
        "topup_paypal",
        "topup_stripe",
        "topup_crypto",
        "x402_info",
    ]

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        proxy_port: Optional[int] = None,
        agent_secret: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._client = DominusNodeClient(
            api_key=api_key,
            base_url=base_url,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
            agent_secret=agent_secret,
        )

    # ----- Proxy tools -----------------------------------------------------

    def proxied_fetch(
        self,
        url: str,
        method: str = "GET",
        country: Optional[str] = None,
        proxy_type: str = "dc",
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Fetch a URL through the Dominus Node rotating proxy network.

        Routes the request through a Dominus Node proxy IP for anonymity and
        geo-targeting.  Only read-only HTTP methods (GET, HEAD, OPTIONS)
        are permitted.

        Args:
            url: The URL to fetch (http or https).
            method: HTTP method -- GET, HEAD, or OPTIONS.  Default: GET.
            country: ISO 3166-1 alpha-2 country code for geo-targeting (e.g. 'US', 'GB').
            proxy_type: Proxy pool -- 'dc' for datacenter ($3/GB) or 'residential' ($5/GB).
            headers: Optional extra headers to include in the request.

        Returns:
            Dict with status code, response headers, and body (truncated to 4000 chars).
        """
        return self._client.proxied_fetch(
            url=url,
            method=method,
            country=country,
            proxy_type=proxy_type,
            headers=headers,
        )

    def check_balance(self) -> Dict[str, Any]:
        """Check the current Dominus Node wallet balance.

        Returns the wallet balance in cents and USD, plus currency type.
        Useful for monitoring spend before making proxied requests.

        Returns:
            Dict with balanceCents, balanceUsd, and currency fields.
        """
        return self._client.check_balance()

    def check_usage(self, period: str = "month") -> Dict[str, Any]:
        """Check proxy usage statistics for a time period.

        Returns bandwidth consumed, cost, and request count.

        Args:
            period: Time period -- 'day', 'week', or 'month' (default).

        Returns:
            Dict with usage summary, records, and time period.
        """
        return self._client.check_usage(period=period)

    def get_proxy_config(self) -> Dict[str, Any]:
        """Get the Dominus Node proxy configuration.

        Returns proxy endpoints (HTTP + SOCKS5), supported countries,
        blocked countries, rotation intervals, and geo-targeting features.

        Returns:
            Dict with proxy configuration details.
        """
        return self._client.get_proxy_config()

    def list_sessions(self) -> Dict[str, Any]:
        """List currently active proxy sessions.

        Returns session IDs, start times, and bytes transferred for
        all active connections.

        Returns:
            Dict with active session information.
        """
        return self._client.list_sessions()

    # ----- Agentic Wallet tools --------------------------------------------

    def create_agentic_wallet(
        self,
        label: str,
        spending_limit_cents: int,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Create a new agentic wallet (server-side custodial sub-wallet).

        Agentic wallets allow AI agents to spend independently with a
        per-transaction spending limit, funded from the main wallet.

        Args:
            label: Human-readable label (max 100 chars, no control chars).
            spending_limit_cents: Per-transaction spending limit in cents.
            daily_limit_cents: Optional daily budget cap in cents (1-1,000,000).
            allowed_domains: Optional list of allowed proxy domains (max 100
                entries, each <= 253 chars, valid domain format).

        Returns:
            Dict with the created wallet ID, label, balance, and limit.
        """
        return self._client.create_agentic_wallet(
            label=label,
            spending_limit_cents=spending_limit_cents,
            daily_limit_cents=daily_limit_cents,
            allowed_domains=allowed_domains,
        )

    def fund_agentic_wallet(
        self, wallet_id: str, amount_cents: int
    ) -> Dict[str, Any]:
        """Fund an agentic wallet from the main wallet.

        Transfers funds from the authenticated user's main wallet to the
        specified agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet to fund.
            amount_cents: Amount to transfer in cents (positive integer).

        Returns:
            Dict with the updated agentic wallet balance.
        """
        return self._client.fund_agentic_wallet(
            wallet_id=wallet_id,
            amount_cents=amount_cents,
        )

    def agentic_wallet_balance(self, wallet_id: str) -> Dict[str, Any]:
        """Check the balance and details of an agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet.

        Returns:
            Dict with wallet ID, label, balance, spending limit, and status.
        """
        return self._client.agentic_wallet_balance(wallet_id=wallet_id)

    def list_agentic_wallets(self) -> Dict[str, Any]:
        """List all agentic wallets owned by the authenticated user.

        Returns:
            Dict or list with all agentic wallet summaries.
        """
        return self._client.list_agentic_wallets()

    def agentic_transactions(
        self, wallet_id: str, limit: int = 20
    ) -> Dict[str, Any]:
        """List transactions for an agentic wallet.

        Args:
            wallet_id: UUID of the agentic wallet.
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            Dict with transaction records including amount, type, and timestamp.
        """
        return self._client.agentic_transactions(
            wallet_id=wallet_id,
            limit=limit,
        )

    def freeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Freeze an agentic wallet to prevent spending.

        The wallet retains its balance but cannot be used for transactions
        until unfrozen.

        Args:
            wallet_id: UUID of the agentic wallet to freeze.

        Returns:
            Dict with the updated wallet status (frozen).
        """
        return self._client.freeze_agentic_wallet(wallet_id=wallet_id)

    def unfreeze_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Unfreeze an agentic wallet to allow spending again.

        Args:
            wallet_id: UUID of the agentic wallet to unfreeze.

        Returns:
            Dict with the updated wallet status (active).
        """
        return self._client.unfreeze_agentic_wallet(wallet_id=wallet_id)

    def delete_agentic_wallet(self, wallet_id: str) -> Dict[str, Any]:
        """Delete an agentic wallet (must be active/unfrozen first).

        Any remaining balance is refunded to the main wallet.

        Args:
            wallet_id: UUID of the agentic wallet to delete.

        Returns:
            Dict confirming deletion and any refunded amount.
        """
        return self._client.delete_agentic_wallet(wallet_id=wallet_id)

    def update_wallet_policy(
        self,
        wallet_id: str,
        daily_limit_cents: Optional[int] = None,
        allowed_domains: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Update the policy of an agentic wallet.

        Sets or clears the daily budget cap and/or domain allowlist for an
        existing agentic wallet.  At least one field must be provided.

        Args:
            wallet_id: UUID of the agentic wallet.
            daily_limit_cents: Optional daily budget cap in cents (1-1,000,000).
            allowed_domains: Optional list of allowed proxy domains (max 100
                entries, each <= 253 chars, valid domain format).

        Returns:
            Dict with the updated wallet policy.
        """
        return self._client.update_wallet_policy(
            wallet_id=wallet_id,
            daily_limit_cents=daily_limit_cents,
            allowed_domains=allowed_domains,
        )

    # ----- Team tools ------------------------------------------------------

    def create_team(
        self, name: str, max_members: Optional[int] = None
    ) -> Dict[str, Any]:
        """Create a new team with a shared wallet for billing.

        Teams allow multiple users to share a single billing wallet.
        The creator becomes the team owner.

        Args:
            name: Team name (max 100 chars, no control characters).
            max_members: Optional maximum team size (1-100).

        Returns:
            Dict with team ID, name, wallet, and owner info.
        """
        return self._client.create_team(name=name, max_members=max_members)

    def list_teams(self) -> Dict[str, Any]:
        """List all teams the authenticated user belongs to.

        Returns:
            Dict or list with team summaries (ID, name, role).
        """
        return self._client.list_teams()

    def team_details(self, team_id: str) -> Dict[str, Any]:
        """Get detailed information about a specific team.

        Includes members, wallet balance, API keys, and settings.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with full team details.
        """
        return self._client.team_details(team_id=team_id)

    def team_fund(self, team_id: str, amount_cents: int) -> Dict[str, Any]:
        """Fund a team wallet from your personal wallet.

        Transfers funds from the authenticated user's wallet to the team
        wallet.  Minimum $1, maximum $10,000 per transfer.

        Args:
            team_id: UUID of the team.
            amount_cents: Amount to transfer (100-1,000,000 cents).

        Returns:
            Dict with the updated team wallet balance.
        """
        return self._client.team_fund(
            team_id=team_id,
            amount_cents=amount_cents,
        )

    def team_create_key(self, team_id: str, label: str) -> Dict[str, Any]:
        """Create an API key scoped to a team (bills to team wallet).

        The key is returned once and cannot be retrieved later.

        Args:
            team_id: UUID of the team.
            label: Human-readable label for the key (max 100 chars).

        Returns:
            Dict with the API key (shown once) and key ID.
        """
        return self._client.team_create_key(
            team_id=team_id,
            label=label,
        )

    def team_usage(self, team_id: str, limit: int = 20) -> Dict[str, Any]:
        """Get team wallet transaction history.

        Args:
            team_id: UUID of the team.
            limit: Maximum transactions to return (1-100, default 20).

        Returns:
            Dict with team wallet transaction records.
        """
        return self._client.team_usage(team_id=team_id, limit=limit)

    def update_team(
        self,
        team_id: str,
        name: Optional[str] = None,
        max_members: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Update team settings (name and/or maximum members).

        At least one of ``name`` or ``max_members`` must be provided.

        Args:
            team_id: UUID of the team.
            name: New team name (max 100 chars).
            max_members: New maximum team size (1-100).

        Returns:
            Dict with the updated team details.
        """
        return self._client.update_team(
            team_id=team_id,
            name=name,
            max_members=max_members,
        )

    def update_team_member_role(
        self, team_id: str, user_id: str, role: str
    ) -> Dict[str, Any]:
        """Update a team member's role (admin or member).

        Only team owners and admins can change member roles.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the member whose role to change.
            role: New role -- 'member' or 'admin'.

        Returns:
            Dict confirming the role update.
        """
        return self._client.update_team_member_role(
            team_id=team_id,
            user_id=user_id,
            role=role,
        )

    # ----- x402 info -------------------------------------------------------

    def x402_info(self) -> Dict[str, Any]:
        """Get x402 micropayment protocol information.

        Returns details about x402 HTTP 402 Payment Required protocol support
        including facilitators, pricing, supported currencies, and payment
        options for AI agent micropayments.

        Returns:
            Dict with x402 protocol information.
        """
        return self._client.x402_info()

    # ----- PayPal top-up ---------------------------------------------------

    def topup_paypal(self, amount_cents: int) -> Dict[str, Any]:
        """Create a PayPal order to top up the wallet.

        Returns an order ID and approval URL.  The user should visit the
        approval URL to complete payment via PayPal.

        Args:
            amount_cents: Amount to top up in cents (500-1,000,000, i.e. $5-$10,000).

        Returns:
            Dict with orderId and approvalUrl for PayPal checkout.
        """
        return self._client.topup_paypal(amount_cents=amount_cents)

    def topup_stripe(self, amount_cents: int) -> Dict[str, Any]:
        """Create a Stripe checkout session to top up the wallet.

        Returns a session ID and checkout URL.  The user should visit the
        checkout URL to complete payment via Stripe.

        Args:
            amount_cents: Amount to top up in cents (500-100,000, i.e. $5-$1,000).

        Returns:
            Dict with sessionId and checkoutUrl for Stripe checkout.
        """
        return self._client.topup_stripe(amount_cents=amount_cents)

    def topup_crypto(
        self, amount_usd: float, currency: str
    ) -> Dict[str, Any]:
        """Create a crypto invoice to top up the wallet via NOWPayments.

        Returns an invoice ID and payment URL.  The user should visit the
        payment URL to complete the crypto payment.

        Args:
            amount_usd: Amount in USD (5-1,000).
            currency: Cryptocurrency to pay with.  One of: BTC, ETH, LTC,
                XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK.

        Returns:
            Dict with invoiceId and paymentUrl for crypto checkout.
        """
        return self._client.topup_crypto(
            amount_usd=amount_usd, currency=currency
        )
