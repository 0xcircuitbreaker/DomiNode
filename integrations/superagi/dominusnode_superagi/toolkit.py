"""Dominus Node SuperAGI Toolkit -- registers all 53 Dominus Node tools.

Provides a ``BaseToolkit`` subclass that exposes 53 tools for interacting
with the Dominus Node rotating proxy-as-a-service platform.  The toolkit
covers proxied HTTP fetching, wallet and usage monitoring, agentic wallet
management, team management (incl. members, invites, keys), account
lifecycle, API key management, plan management, x402 micropayments, and
payment top-ups.

Example::

    from dominusnode_superagi.toolkit import DominusNodeToolkit

    toolkit = DominusNodeToolkit()
    tools = toolkit.get_tools()
    # Each tool has .name, .description, .args_schema, and ._execute()

Requires ``DOMINUSNODE_API_KEY`` (and optionally ``DOMINUSNODE_BASE_URL``,
``DOMINUSNODE_PROXY_HOST``, ``DOMINUSNODE_PROXY_PORT``) to be set in
SuperAGI's tool configuration.
"""

from __future__ import annotations

try:
    from superagi.tools.base_tool import BaseToolkit
except ImportError:
    BaseToolkit = object  # Standalone mode — SuperAGI framework not installed

from dominusnode_superagi.tools import (
    DominusNodeAccountInfoTool,
    DominusNodeAgenticTransactionsTool,
    DominusNodeAgenticWalletBalanceTool,
    DominusNodeBalanceTool,
    DominusNodeChangePlanTool,
    DominusNodeCheckPaymentTool,
    DominusNodeCreateAgenticWalletTool,
    DominusNodeCreateKeyTool,
    DominusNodeCreateTeamTool,
    DominusNodeDailyUsageTool,
    DominusNodeDeleteAgenticWalletTool,
    DominusNodeForecastTool,
    DominusNodeFreezeAgenticWalletTool,
    DominusNodeFundAgenticWalletTool,
    DominusNodeGetPlanTool,
    DominusNodeListAgenticWalletsTool,
    DominusNodeListKeysTool,
    DominusNodeListPlansTool,
    DominusNodeListTeamsTool,
    DominusNodeLoginTool,
    DominusNodeProxiedFetchTool,
    DominusNodeProxyConfigTool,
    DominusNodeProxyStatusTool,
    DominusNodeRegisterTool,
    DominusNodeResendVerificationTool,
    DominusNodeRevokeKeyTool,
    DominusNodeSessionsTool,
    DominusNodeTeamAddMemberTool,
    DominusNodeTeamCancelInviteTool,
    DominusNodeTeamCreateKeyTool,
    DominusNodeTeamDeleteTool,
    DominusNodeTeamDetailsTool,
    DominusNodeTeamFundTool,
    DominusNodeTeamInviteMemberTool,
    DominusNodeTeamListInvitesTool,
    DominusNodeTeamListKeysTool,
    DominusNodeTeamListMembersTool,
    DominusNodeTeamRemoveMemberTool,
    DominusNodeTeamRevokeKeyTool,
    DominusNodeTeamUsageTool,
    DominusNodeTopHostsTool,
    DominusNodeTopupCryptoTool,
    DominusNodeTopupPaypalTool,
    DominusNodeTopupStripeTool,
    DominusNodeTransactionsTool,
    DominusNodeUnfreezeAgenticWalletTool,
    DominusNodeUpdatePasswordTool,
    DominusNodeUpdateTeamMemberRoleTool,
    DominusNodeUpdateTeamTool,
    DominusNodeUpdateWalletPolicyTool,
    DominusNodeUsageTool,
    DominusNodeVerifyEmailTool,
    DominusNodeX402InfoTool,
)


class DominusNodeToolkit(BaseToolkit):
    """SuperAGI toolkit providing 53 Dominus Node proxy service tools.

    Tools include:

    **Proxy Operations (3):**
      - Proxied Fetch -- fetch URLs through rotating proxies
      - Proxy Config -- get proxy endpoint configuration
      - Proxy Status -- get gateway status, uptime, and pool health

    **Sessions (1):**
      - List Sessions -- view active proxy sessions

    **Wallet (4):**
      - Check Balance -- view wallet balance
      - Get Transactions -- main wallet transaction history
      - Get Forecast -- spending forecast and burn rate
      - Check Payment -- check crypto payment invoice status

    **Usage (3):**
      - Check Usage -- view usage statistics
      - Daily Usage -- per-day bandwidth breakdown
      - Top Hosts -- top hosts by bandwidth consumption

    **Agentic Wallets (9):**
      - Create, Fund, Balance, List, Transactions
      - Freeze, Unfreeze, Delete, Update Policy

    **Account (6):**
      - Register, Login, Account Info
      - Verify Email, Resend Verification, Update Password

    **API Keys (3):**
      - List Keys, Create Key, Revoke Key

    **Plans (3):**
      - Get Plan, List Plans, Change Plan

    **Teams (17):**
      - Create, List, Details, Fund, Create Key, Usage
      - Update Team, Update Member Role, Delete
      - Revoke Key, List Keys, List Members
      - Add Member, Remove Member
      - Invite Member, List Invites, Cancel Invite

    **Payments (3):**
      - TopUp Stripe -- create Stripe checkout session
      - TopUp PayPal -- create PayPal top-up order
      - TopUp Crypto -- create crypto invoice via NOWPayments

    **Micropayments (1):**
      - X402 Info -- micropayment protocol details
    """

    name: str = "Dominus Node Proxy Toolkit"
    description: str = (
        "Rotating proxy-as-a-service with wallet billing, team management, "
        "agentic sub-wallets, account lifecycle, API key management, plan "
        "management, and x402 micropayments. Datacenter proxies at $3/GB, "
        "residential at $5/GB."
    )

    def get_tools(self) -> list:
        """Return all 53 Dominus Node tools for registration in SuperAGI.

        Returns:
            A list of 53 BaseTool instances covering proxy, wallet, usage,
            account, API key, plan, team, and payment operations.
        """
        return [
            # Proxy (3)
            DominusNodeProxiedFetchTool(),
            DominusNodeProxyConfigTool(),
            DominusNodeProxyStatusTool(),
            # Sessions (1)
            DominusNodeSessionsTool(),
            # Wallet (4)
            DominusNodeBalanceTool(),
            DominusNodeTransactionsTool(),
            DominusNodeForecastTool(),
            DominusNodeCheckPaymentTool(),
            # Usage (3)
            DominusNodeUsageTool(),
            DominusNodeDailyUsageTool(),
            DominusNodeTopHostsTool(),
            # Agentic Wallets (9)
            DominusNodeCreateAgenticWalletTool(),
            DominusNodeFundAgenticWalletTool(),
            DominusNodeAgenticWalletBalanceTool(),
            DominusNodeListAgenticWalletsTool(),
            DominusNodeAgenticTransactionsTool(),
            DominusNodeFreezeAgenticWalletTool(),
            DominusNodeUnfreezeAgenticWalletTool(),
            DominusNodeDeleteAgenticWalletTool(),
            DominusNodeUpdateWalletPolicyTool(),
            # Account (6)
            DominusNodeRegisterTool(),
            DominusNodeLoginTool(),
            DominusNodeAccountInfoTool(),
            DominusNodeVerifyEmailTool(),
            DominusNodeResendVerificationTool(),
            DominusNodeUpdatePasswordTool(),
            # API Keys (3)
            DominusNodeListKeysTool(),
            DominusNodeCreateKeyTool(),
            DominusNodeRevokeKeyTool(),
            # Plans (3)
            DominusNodeGetPlanTool(),
            DominusNodeListPlansTool(),
            DominusNodeChangePlanTool(),
            # Teams (17)
            DominusNodeCreateTeamTool(),
            DominusNodeListTeamsTool(),
            DominusNodeTeamDetailsTool(),
            DominusNodeTeamFundTool(),
            DominusNodeTeamCreateKeyTool(),
            DominusNodeTeamUsageTool(),
            DominusNodeUpdateTeamTool(),
            DominusNodeUpdateTeamMemberRoleTool(),
            DominusNodeTeamDeleteTool(),
            DominusNodeTeamRevokeKeyTool(),
            DominusNodeTeamListKeysTool(),
            DominusNodeTeamListMembersTool(),
            DominusNodeTeamAddMemberTool(),
            DominusNodeTeamRemoveMemberTool(),
            DominusNodeTeamInviteMemberTool(),
            DominusNodeTeamListInvitesTool(),
            DominusNodeTeamCancelInviteTool(),
            # Payments (3)
            DominusNodeTopupPaypalTool(),
            DominusNodeTopupStripeTool(),
            DominusNodeTopupCryptoTool(),
            # Micropayments (1)
            DominusNodeX402InfoTool(),
        ]

    def get_env_keys(self) -> list:
        """Return the environment/config keys needed by Dominus Node tools.

        Returns:
            A list of configuration key names that SuperAGI should prompt
            the user to set.
        """
        return [
            "DOMINUSNODE_API_KEY",
            "DOMINUSNODE_BASE_URL",
            "DOMINUSNODE_PROXY_HOST",
            "DOMINUSNODE_PROXY_PORT",
        ]
