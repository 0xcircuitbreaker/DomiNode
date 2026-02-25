"""DomiNode IronClaw AI agent integration.

Provides a Python toolkit for NEAR AI's IronClaw agent runtime, exposing
23 tools for interacting with the DomiNode rotating proxy-as-a-service
platform.  Supports both direct Python bridge usage and MCP Protocol
configuration for IronClaw's native MCP bridge.

Example::

    from dominusnode_ironclaw import DominusNodeToolkit

    toolkit = DominusNodeToolkit(api_key="dn_live_...")
    result = toolkit.check_balance()  # JSON string
    tools = toolkit.get_tool_definitions()  # IronClaw-compatible dicts
    mcp = toolkit.get_mcp_config()  # MCP server connection config
"""

from dominusnode_ironclaw.tools import DominusNodeToolkit

__version__ = "1.0.0"
__all__ = ["DominusNodeToolkit", "__version__"]
