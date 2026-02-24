"""CrewAI tools for DomiNode rotating proxy service.

Provides CrewAI-compatible tools for fetching web content through rotating
proxies, checking wallet balance, and listing available geo-targeting options
through the DomiNode platform.

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
    DominusNodeBalanceTool,
    DominusNodeGeoTargetTool,
    DominusNodeTopupPaypalTool,
    DominusNodeWebScrapeTool,
)

__all__ = [
    "DominusNodeWebScrapeTool",
    "DominusNodeBalanceTool",
    "DominusNodeGeoTargetTool",
    "DominusNodeTopupPaypalTool",
]
