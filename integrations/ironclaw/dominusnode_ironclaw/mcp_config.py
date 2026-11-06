"""IronClaw MCP bridge configuration for the DominusNode MCP server (v2).

The MCP server (``@dominusnode/mcp-server``) runs locally over stdio and reads its key
from ``DOMINUSNODE_API_KEY``. The generated config references that variable by name;
it never embeds the key itself.
"""

from __future__ import annotations

from typing import Any, Dict, Optional


def generate_mcp_config(base_url: Optional[str] = None) -> Dict[str, Any]:
    """Return an IronClaw MCP server entry that launches the DominusNode MCP server.

    Args:
        base_url: Optional API base URL override, passed as ``DOMINUSNODE_API_URL``.
    """
    env: Dict[str, str] = {"DOMINUSNODE_API_KEY": "${DOMINUSNODE_API_KEY}"}
    if base_url:
        env["DOMINUSNODE_API_URL"] = base_url.rstrip("/")
    return {
        "server": {
            "name": "dominusnode",
            "description": "DominusNode agent relay network: fetch through relay nodes, pricing, wallet, node earnings",
            "transport": {
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@dominusnode/mcp-server"],
                "env": env,
            },
        },
        "capabilities": {"tools": True, "resources": False, "prompts": False},
    }
