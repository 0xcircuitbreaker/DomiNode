"""MCP configuration helper for IronClaw's native MCP bridge.

Generates connection configuration that IronClaw agents can use to connect
to the Dominus Node MCP server, which exposes 57 authenticated tools for proxy,
wallet, team, and payment management.

Example::

    from dominusnode_ironclaw.mcp_config import generate_mcp_config

    config = generate_mcp_config(
        base_url="https://api.dominusnode.com",
        api_key="dn_live_abc123",
    )
    # Pass config to IronClaw's MCP bridge
"""

from __future__ import annotations

from typing import Any, Dict


def generate_mcp_config(
    base_url: str = "https://api.dominusnode.com",
    api_key: str = "",
) -> Dict[str, Any]:
    """Generate an IronClaw-compatible MCP server connection configuration.

    This configuration tells IronClaw how to connect to the Dominus Node MCP
    server, which provides 57 authenticated tools for proxy, wallet, team,
    and payment management.

    Args:
        base_url: Base URL of the Dominus Node API (default: production).
        api_key: Dominus Node API key (``dn_live_...`` or ``dn_test_...``).

    Returns:
        A dictionary suitable for IronClaw's MCP bridge configuration.
    """
    base = base_url.rstrip("/")

    return {
        "server": {
            "name": "dominusnode",
            "description": "Dominus Node rotating proxy-as-a-service MCP server",
            "transport": {
                "type": "streamable-http",
                "url": f"{base}/mcp",
            },
            "auth": {
                "type": "custom",
                "headers": {
                    "X-API-Key": api_key,
                    "X-DominusNode-Agent": "mcp",
                    "User-Agent": "dominusnode-ironclaw/1.0.0",
                },
            },
        },
        "capabilities": {
            "tools": True,
            "resources": False,
            "prompts": False,
        },
        "metadata": {
            "version": "1.0.0",
            "tool_count": 57,
            "categories": [
                "proxy",
                "wallet",
                "agentic-wallet",
                "team",
                "payment",
                "usage",
                "session",
                "x402",
            ],
        },
    }
