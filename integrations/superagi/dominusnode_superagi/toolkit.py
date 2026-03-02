"""Dominus Node SuperAGI Toolkit -- registers all 26 Dominus Node tools.

Provides a ``BaseToolkit`` subclass that exposes 26 tools for interacting
with the Dominus Node rotating proxy-as-a-service platform.  The toolkit
covers proxied HTTP fetching, wallet and usage monitoring, agentic wallet
management, team management, x402 micropayments, and payment top-ups.

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

from superagi.tools.base_tool import BaseToolkit

from dominusnode_superagi.tools import (
    DominusNodeAgenticTransactionsTool,
    DominusNodeAgenticWalletBalanceTool,
    DominusNodeBalanceTool,
    DominusNodeCreateAgenticWalletTool,
    DominusNodeCreateTeamTool,
    DominusNodeDeleteAgenticWalletTool,
    DominusNodeFreezeAgenticWalletTool,
    DominusNodeFundAgenticWalletTool,
    DominusNodeListAgenticWalletsTool,
    DominusNodeListTeamsTool,
    DominusNodeProxiedFetchTool,
    DominusNodeProxyConfigTool,
    DominusNodeSessionsTool,
    DominusNodeTeamCreateKeyTool,
    DominusNodeTeamDetailsTool,
    DominusNodeTeamFundTool,
    DominusNodeTeamUsageTool,
    DominusNodeTopupCryptoTool,
    DominusNodeTopupPaypalTool,
    DominusNodeTopupStripeTool,
    DominusNodeUnfreezeAgenticWalletTool,
    DominusNodeUpdateTeamMemberRoleTool,
    DominusNodeUpdateTeamTool,
    DominusNodeUpdateWalletPolicyTool,
    DominusNodeUsageTool,
    DominusNodeX402InfoTool,
)


class DominusNodeToolkit(BaseToolkit):
    """SuperAGI toolkit providing 22 Dominus Node proxy service tools.

    Tools include:

    **Proxy Operations:**
      - Proxied Fetch -- fetch URLs through rotating proxies
      - Proxy Config -- get proxy endpoint configuration
      - List Sessions -- view active proxy sessions

    **Wallet:**
      - Check Balance -- view wallet balance
      - Check Usage -- view usage statistics
      - TopUp PayPal -- create a PayPal wallet top-up order

    **Agentic Wallets:**
      - Create, Fund, Balance, List, Transactions
      - Freeze, Unfreeze, Delete

    **Teams:**
      - Create, List, Details, Fund, Create Key, Usage
      - Update Team, Update Member Role

    **Payments:**
      - TopUp Stripe -- create Stripe checkout session
      - TopUp Crypto -- create crypto invoice via NOWPayments
      - X402 Info -- micropayment protocol details
    """

    name: str = "Dominus Node Proxy Toolkit"
    description: str = (
        "Rotating proxy-as-a-service with wallet billing, team management, "
        "agentic sub-wallets, and x402 micropayments. Datacenter proxies at "
        "$3/GB, residential at $5/GB."
    )

    def get_tools(self) -> list:
        """Return all 26 Dominus Node tools for registration in SuperAGI.

        Returns:
            A list of 26 BaseTool instances covering proxy, wallet, team,
            and payment operations.
        """
        return [
            DominusNodeProxiedFetchTool(),
            DominusNodeBalanceTool(),
            DominusNodeUsageTool(),
            DominusNodeProxyConfigTool(),
            DominusNodeSessionsTool(),
            DominusNodeCreateAgenticWalletTool(),
            DominusNodeFundAgenticWalletTool(),
            DominusNodeAgenticWalletBalanceTool(),
            DominusNodeListAgenticWalletsTool(),
            DominusNodeAgenticTransactionsTool(),
            DominusNodeFreezeAgenticWalletTool(),
            DominusNodeUnfreezeAgenticWalletTool(),
            DominusNodeDeleteAgenticWalletTool(),
            DominusNodeUpdateWalletPolicyTool(),
            DominusNodeCreateTeamTool(),
            DominusNodeListTeamsTool(),
            DominusNodeTeamDetailsTool(),
            DominusNodeTeamFundTool(),
            DominusNodeTeamCreateKeyTool(),
            DominusNodeTeamUsageTool(),
            DominusNodeUpdateTeamTool(),
            DominusNodeUpdateTeamMemberRoleTool(),
            DominusNodeX402InfoTool(),
            DominusNodeTopupPaypalTool(),
            DominusNodeTopupStripeTool(),
            DominusNodeTopupCryptoTool(),
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
