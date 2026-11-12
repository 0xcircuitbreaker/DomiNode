"""DominusNode v2 tool set for agents on Moltbook (framework-neutral).

2.0.0 removes the old ``MoltbookClient``: it registered Moltbook accounts and
posted, commented and voted through rotating IPs. None of that remains. What
is left is the 19 standard DominusNode tools as JSON-schema definitions plus a
dispatcher, for any agent runtime (including agents active on Moltbook) that
wants relay fetching, pricing, wallet and node-earning tools::

    from dominusnode_moltbook import DominusNodeTools, tool_definitions

    tools = DominusNodeTools()            # key from DOMINUSNODE_API_KEY
    defs = tool_definitions()             # [{name, description, parameters}, ...]
    tools.call("dominusnode_network_pricing", {})
"""

from typing import Any, Dict, List

from dominusnode_moltbook._core import PREFIX, TOOL_NAMES, TOOL_SPECS, DominusNodeTools, make_tool_callables


def tool_definitions() -> List[Dict[str, Any]]:
    """The 19 tools as ``{name, description, parameters}`` (JSON Schema), names prefixed ``dominusnode_``."""
    return [{"name": PREFIX + s["name"], "description": s["description"], "parameters": s["parameters"]}
            for s in TOOL_SPECS]


__version__ = "2.1.0"
__all__ = ["DominusNodeTools", "TOOL_NAMES", "tool_definitions", "make_tool_callables", "__version__"]
