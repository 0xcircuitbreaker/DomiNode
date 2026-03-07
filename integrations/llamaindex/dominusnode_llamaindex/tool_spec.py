"""Dominus Node LlamaIndex ToolSpec -- exposes all 53 functions as LlamaIndex tools.

The :class:`DominusNodeToolSpec` subclasses
:class:`llama_index.core.tools.tool_spec.base.BaseToolSpec` and delegates
every method to an internal :class:`DominusNodeClient`.  This allows
LlamaIndex agents to call Dominus Node proxy, wallet, agentic wallet, team,
account lifecycle, API key, plan, and payment tools through a unified
interface.

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

    Provides 53 tools covering proxy operations, wallet management,
    agentic wallets, team management, account lifecycle, API keys,
    plans, payment top-ups, and x402 info.

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
        # Proxy (6)
        "proxied_fetch",
        "check_balance",
        "check_usage",
        "get_proxy_config",
        "list_sessions",
        "get_proxy_status",
        # Agentic Wallet (9)
        "create_agentic_wallet",
        "fund_agentic_wallet",
        "agentic_wallet_balance",
        "list_agentic_wallets",
        "agentic_transactions",
        "freeze_agentic_wallet",
        "unfreeze_agentic_wallet",
        "delete_agentic_wallet",
        "update_wallet_policy",
        # Team (17)
        "create_team",
        "list_teams",
        "team_details",
        "team_fund",
        "team_create_key",
        "team_usage",
        "update_team",
        "update_team_member_role",
        "team_delete",
        "team_revoke_key",
        "team_list_keys",
        "team_list_members",
        "team_add_member",
        "team_remove_member",
        "team_invite_member",
        "team_list_invites",
        "team_cancel_invite",
        # Payments (3)
        "topup_paypal",
        "topup_stripe",
        "topup_crypto",
        # x402 (1)
        "x402_info",
        # Wallet extended (3)
        "get_transactions",
        "get_forecast",
        "check_payment",
        # Usage extended (2)
        "get_daily_usage",
        "get_top_hosts",
        # Account (6)
        "register",
        "login",
        "get_account_info",
        "verify_email",
        "resend_verification",
        "update_password",
        # API Keys (3)
        "list_keys",
        "create_key",
        "revoke_key",
        # Plans (3)
        "get_plan",
        "list_plans",
        "change_plan",
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

    # ----- Proxy status ----------------------------------------------------

    def get_proxy_status(self) -> Dict[str, Any]:
        """Get the current status of the proxy gateway.

        Returns operational status, uptime, and health information for
        the Dominus Node proxy gateway.

        Returns:
            Dict with proxy gateway status information.
        """
        return self._client.get_proxy_status()

    # ----- Wallet extended -------------------------------------------------

    def get_transactions(self, limit: int = 20) -> Dict[str, Any]:
        """Get wallet transaction history.

        Returns recent wallet transactions including top-ups, proxy usage
        charges, team transfers, and agentic wallet funding.

        Args:
            limit: Maximum number of transactions to return (1-100, default 20).

        Returns:
            Dict with wallet transaction history.
        """
        return self._client.get_transactions(limit=limit)

    def get_forecast(self) -> Dict[str, Any]:
        """Get wallet balance forecast based on recent usage trends.

        Predicts when the wallet balance will reach zero based on
        current spending patterns.

        Returns:
            Dict with wallet balance forecast information.
        """
        return self._client.get_forecast()

    def check_payment(self, invoice_id: str) -> Dict[str, Any]:
        """Check the status of a crypto top-up payment.

        Use after ``topup_crypto`` to poll whether the payment has been
        confirmed on-chain and the wallet has been credited.

        Args:
            invoice_id: The invoice ID from a previous ``topup_crypto`` call.

        Returns:
            Dict with payment status information.
        """
        return self._client.check_payment(invoice_id=invoice_id)

    # ----- Usage extended --------------------------------------------------

    def get_daily_usage(self, days: int = 30) -> Dict[str, Any]:
        """Get daily usage breakdown.

        Returns per-day bandwidth, cost, and request counts for the
        specified number of recent days.

        Args:
            days: Number of days of history to retrieve (1-90, default 30).

        Returns:
            Dict with daily usage breakdown.
        """
        return self._client.get_daily_usage(days=days)

    def get_top_hosts(self, limit: int = 10) -> Dict[str, Any]:
        """Get the top hosts by bandwidth usage.

        Returns the most frequently accessed hosts ranked by total
        bandwidth consumed through the proxy.

        Args:
            limit: Maximum number of hosts to return (1-50, default 10).

        Returns:
            Dict with top hosts by usage.
        """
        return self._client.get_top_hosts(limit=limit)

    # ----- Account tools ---------------------------------------------------

    def register(self, email: str, password: str) -> Dict[str, Any]:
        """Register a new Dominus Node account.

        This is an unauthenticated endpoint -- no API key or token needed.
        After registration, the user must verify their email before
        accessing financial endpoints.

        Args:
            email: Email address for the new account.
            password: Password for the new account (8-128 characters).

        Returns:
            Dict with registration result.
        """
        return self._client.register(email=email, password=password)

    def login(self, email: str, password: str) -> Dict[str, Any]:
        """Log in to a Dominus Node account.

        This is an unauthenticated endpoint -- no API key or token needed.
        Returns JWT access and refresh tokens on success.

        Args:
            email: Account email address.
            password: Account password.

        Returns:
            Dict with login result (access and refresh tokens).
        """
        return self._client.login(email=email, password=password)

    def get_account_info(self) -> Dict[str, Any]:
        """Get current account information.

        Returns the authenticated user's email, plan, verification status,
        and other profile details.

        Returns:
            Dict with account details.
        """
        return self._client.get_account_info()

    def verify_email(self, token: str) -> Dict[str, Any]:
        """Verify an email address using a verification token.

        This is an unauthenticated endpoint -- no API key or token needed.
        The token is received via the email sent after registration.

        Args:
            token: The email verification token received via email.

        Returns:
            Dict confirming email verification.
        """
        return self._client.verify_email(token=token)

    def resend_verification(self) -> Dict[str, Any]:
        """Resend the email verification link.

        Sends a new verification email to the authenticated user's
        email address if not yet verified.

        Returns:
            Dict confirming the verification email was resent.
        """
        return self._client.resend_verification()

    def update_password(
        self, current_password: str, new_password: str
    ) -> Dict[str, Any]:
        """Change the account password.

        Requires the current password for verification before setting
        the new password.

        Args:
            current_password: The current account password.
            new_password: The new password (8-128 characters).

        Returns:
            Dict confirming the password change.
        """
        return self._client.update_password(
            current_password=current_password,
            new_password=new_password,
        )

    # ----- API Key tools ---------------------------------------------------

    def list_keys(self) -> Dict[str, Any]:
        """List all API keys for the current account.

        Returns key IDs, labels, creation dates, and last-used timestamps.
        The actual key values are not returned (they are shown only at
        creation time).

        Returns:
            Dict with a list of API keys.
        """
        return self._client.list_keys()

    def create_key(self, label: str) -> Dict[str, Any]:
        """Create a new API key.

        The key value is returned once in the response and cannot be
        retrieved later.  Store it securely.

        Args:
            label: Human-readable label for the key (max 100 chars, no control characters).

        Returns:
            Dict with the created API key (shown once) and key ID.
        """
        return self._client.create_key(label=label)

    def revoke_key(self, key_id: str) -> Dict[str, Any]:
        """Revoke (delete) an API key.

        The key will immediately stop working for authentication.

        Args:
            key_id: ID of the API key to revoke.

        Returns:
            Dict confirming the key revocation.
        """
        return self._client.revoke_key(key_id=key_id)

    # ----- Plan tools ------------------------------------------------------

    def get_plan(self) -> Dict[str, Any]:
        """Get the current user's plan.

        Returns the plan name, limits, pricing tier, and features.

        Returns:
            Dict with the user's current plan details.
        """
        return self._client.get_plan()

    def list_plans(self) -> Dict[str, Any]:
        """List all available plans.

        Returns all plans that can be subscribed to, with their
        features, limits, and pricing.

        Returns:
            Dict with a list of available plans.
        """
        return self._client.list_plans()

    def change_plan(self, plan_id: str) -> Dict[str, Any]:
        """Change the user's plan.

        Switches the authenticated user's subscription to the specified
        plan.  May adjust rate limits and feature access immediately.

        Args:
            plan_id: UUID of the plan to switch to.

        Returns:
            Dict with the updated plan details.
        """
        return self._client.change_plan(plan_id=plan_id)

    # ----- Extended Team tools ---------------------------------------------

    def team_delete(self, team_id: str) -> Dict[str, Any]:
        """Delete a team.

        Permanently removes the team, revokes all team API keys, and
        removes all members.  Only the team owner can delete a team.

        Args:
            team_id: UUID of the team to delete.

        Returns:
            Dict confirming team deletion.
        """
        return self._client.team_delete(team_id=team_id)

    def team_revoke_key(self, team_id: str, key_id: str) -> Dict[str, Any]:
        """Revoke (delete) an API key from a team.

        The key will immediately stop working for authentication.

        Args:
            team_id: UUID of the team.
            key_id: ID of the API key to revoke.

        Returns:
            Dict confirming the key revocation.
        """
        return self._client.team_revoke_key(
            team_id=team_id, key_id=key_id
        )

    def team_list_keys(self, team_id: str) -> Dict[str, Any]:
        """List all API keys for a team.

        Returns key IDs, labels, and creation dates for all keys
        scoped to the team.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of team API keys.
        """
        return self._client.team_list_keys(team_id=team_id)

    def team_list_members(self, team_id: str) -> Dict[str, Any]:
        """List all members of a team.

        Returns user IDs, emails, roles (owner/admin/member), and
        join dates for all team members.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of team members.
        """
        return self._client.team_list_members(team_id=team_id)

    def team_add_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        """Add a member to a team by user ID.

        The user must have an existing Dominus Node account.  They
        will be added with the default 'member' role.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to add.

        Returns:
            Dict confirming the member addition.
        """
        return self._client.team_add_member(
            team_id=team_id, user_id=user_id
        )

    def team_remove_member(self, team_id: str, user_id: str) -> Dict[str, Any]:
        """Remove a member from a team.

        The user will lose access to team resources and API keys.
        Cannot remove the team owner.

        Args:
            team_id: UUID of the team.
            user_id: UUID of the user to remove.

        Returns:
            Dict confirming the member removal.
        """
        return self._client.team_remove_member(
            team_id=team_id, user_id=user_id
        )

    def team_invite_member(
        self, team_id: str, email: str, role: str = "member"
    ) -> Dict[str, Any]:
        """Invite a user to a team by email.

        Sends an invitation email.  The user can accept or decline
        the invite.  If they don't have an account, they will be
        prompted to register first.

        Args:
            team_id: UUID of the team.
            email: Email address of the user to invite.
            role: Role for the invited user ('member' or 'admin'). Default: 'member'.

        Returns:
            Dict with the created invite details.
        """
        return self._client.team_invite_member(
            team_id=team_id, email=email, role=role
        )

    def team_list_invites(self, team_id: str) -> Dict[str, Any]:
        """List pending invites for a team.

        Returns all invitations that have not yet been accepted,
        declined, or cancelled.

        Args:
            team_id: UUID of the team.

        Returns:
            Dict with a list of pending team invites.
        """
        return self._client.team_list_invites(team_id=team_id)

    def team_cancel_invite(self, team_id: str, invite_id: str) -> Dict[str, Any]:
        """Cancel a pending team invite.

        The invite link will no longer be valid.

        Args:
            team_id: UUID of the team.
            invite_id: UUID of the invite to cancel.

        Returns:
            Dict confirming the invite cancellation.
        """
        return self._client.team_cancel_invite(
            team_id=team_id, invite_id=invite_id
        )
