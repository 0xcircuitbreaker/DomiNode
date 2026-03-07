"""CrewAI tools for Dominus Node rotating proxy service (53 tools).

Provides CrewAI-compatible tools for fetching web content through rotating
proxies, managing wallets, teams, API keys, plans, usage tracking, and
account management through the Dominus Node platform.

Example::

    from dominusnode_crewai import (
        DominusNodeWebScrapeTool,
        DominusNodeBalanceTool,
        DominusNodeGeoTargetTool,
    )

    scrape_tool = DominusNodeWebScrapeTool(api_key="dn_live_...")
    balance_tool = DominusNodeBalanceTool(api_key="dn_live_...")
    geo_tool = DominusNodeGeoTargetTool(api_key="dn_live_...")

    # Use with a CrewAI agent
    from crewai import Agent
    agent = Agent(
        role="Web Researcher",
        tools=[scrape_tool, balance_tool, geo_tool],
        ...
    )
"""

from .tools import (
    # Proxy (3)
    DominusNodeWebScrapeTool,
    DominusNodeGeoTargetTool,
    DominusNodeProxyStatusTool,
    # Sessions (1)
    DominusNodeListSessionsTool,
    # Wallet (8)
    DominusNodeBalanceTool,
    DominusNodeGetTransactionsTool,
    DominusNodeGetForecastTool,
    DominusNodeTopupPaypalTool,
    DominusNodeTopupStripeTool,
    DominusNodeTopupCryptoTool,
    DominusNodeCheckPaymentTool,
    DominusNodeX402InfoTool,
    # Usage (3)
    DominusNodeCheckUsageTool,
    DominusNodeGetDailyUsageTool,
    DominusNodeGetTopHostsTool,
    # Account (6)
    DominusNodeRegisterTool,
    DominusNodeLoginTool,
    DominusNodeGetAccountInfoTool,
    DominusNodeVerifyEmailTool,
    DominusNodeResendVerificationTool,
    DominusNodeUpdatePasswordTool,
    # API Keys (3)
    DominusNodeListKeysTool,
    DominusNodeCreateKeyTool,
    DominusNodeRevokeKeyTool,
    # Plans (3)
    DominusNodeGetPlanTool,
    DominusNodeListPlansTool,
    DominusNodeChangePlanTool,
    # Agentic Wallets (9)
    DominusNodeCreateAgenticWalletTool,
    DominusNodeFundAgenticWalletTool,
    DominusNodeAgenticWalletBalanceTool,
    DominusNodeListAgenticWalletsTool,
    DominusNodeAgenticTransactionsTool,
    DominusNodeFreezeAgenticWalletTool,
    DominusNodeUnfreezeAgenticWalletTool,
    DominusNodeDeleteAgenticWalletTool,
    DominusNodeUpdateWalletPolicyTool,
    # Teams (17)
    DominusNodeCreateTeamTool,
    DominusNodeListTeamsTool,
    DominusNodeTeamDetailsTool,
    DominusNodeUpdateTeamTool,
    DominusNodeTeamDeleteTool,
    DominusNodeTeamFundTool,
    DominusNodeTeamCreateKeyTool,
    DominusNodeTeamRevokeKeyTool,
    DominusNodeTeamListKeysTool,
    DominusNodeTeamUsageTool,
    DominusNodeTeamListMembersTool,
    DominusNodeTeamAddMemberTool,
    DominusNodeTeamRemoveMemberTool,
    DominusNodeUpdateTeamMemberRoleTool,
    DominusNodeTeamInviteMemberTool,
    DominusNodeTeamListInvitesTool,
    DominusNodeTeamCancelInviteTool,
)

__all__ = [
    # Proxy (3)
    "DominusNodeWebScrapeTool",
    "DominusNodeGeoTargetTool",
    "DominusNodeProxyStatusTool",
    # Sessions (1)
    "DominusNodeListSessionsTool",
    # Wallet (8)
    "DominusNodeBalanceTool",
    "DominusNodeGetTransactionsTool",
    "DominusNodeGetForecastTool",
    "DominusNodeTopupPaypalTool",
    "DominusNodeTopupStripeTool",
    "DominusNodeTopupCryptoTool",
    "DominusNodeCheckPaymentTool",
    "DominusNodeX402InfoTool",
    # Usage (3)
    "DominusNodeCheckUsageTool",
    "DominusNodeGetDailyUsageTool",
    "DominusNodeGetTopHostsTool",
    # Account (6)
    "DominusNodeRegisterTool",
    "DominusNodeLoginTool",
    "DominusNodeGetAccountInfoTool",
    "DominusNodeVerifyEmailTool",
    "DominusNodeResendVerificationTool",
    "DominusNodeUpdatePasswordTool",
    # API Keys (3)
    "DominusNodeListKeysTool",
    "DominusNodeCreateKeyTool",
    "DominusNodeRevokeKeyTool",
    # Plans (3)
    "DominusNodeGetPlanTool",
    "DominusNodeListPlansTool",
    "DominusNodeChangePlanTool",
    # Agentic Wallets (9)
    "DominusNodeCreateAgenticWalletTool",
    "DominusNodeFundAgenticWalletTool",
    "DominusNodeAgenticWalletBalanceTool",
    "DominusNodeListAgenticWalletsTool",
    "DominusNodeAgenticTransactionsTool",
    "DominusNodeFreezeAgenticWalletTool",
    "DominusNodeUnfreezeAgenticWalletTool",
    "DominusNodeDeleteAgenticWalletTool",
    "DominusNodeUpdateWalletPolicyTool",
    # Teams (17)
    "DominusNodeCreateTeamTool",
    "DominusNodeListTeamsTool",
    "DominusNodeTeamDetailsTool",
    "DominusNodeUpdateTeamTool",
    "DominusNodeTeamDeleteTool",
    "DominusNodeTeamFundTool",
    "DominusNodeTeamCreateKeyTool",
    "DominusNodeTeamRevokeKeyTool",
    "DominusNodeTeamListKeysTool",
    "DominusNodeTeamUsageTool",
    "DominusNodeTeamListMembersTool",
    "DominusNodeTeamAddMemberTool",
    "DominusNodeTeamRemoveMemberTool",
    "DominusNodeUpdateTeamMemberRoleTool",
    "DominusNodeTeamInviteMemberTool",
    "DominusNodeTeamListInvitesTool",
    "DominusNodeTeamCancelInviteTool",
]
