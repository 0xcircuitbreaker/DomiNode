"""IronClaw Python-bridge tool definitions for the DominusNode v2 standard tool set.

IronClaw's Python bridge consumes tool dicts of the form
``{"name", "description", "parameters" (JSON Schema), "handler"}``; handlers return
JSON strings.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from dominusnode_ironclaw._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_ironclaw._core import DominusNodeToolkit as _CoreToolkit
from dominusnode_ironclaw.mcp_config import generate_mcp_config

TOOL_PREFIX = "dominusnode_"


class DominusNodeToolkit(_CoreToolkit):
    """The 19 DominusNode tools as IronClaw bridge tool definitions.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` argument);
    it is never a tool parameter and never appears in a tool result.
    """

    def _handler(self, name: str) -> Callable[..., str]:
        def run(**kwargs: Any) -> str:
            return self.call_json(name, kwargs)

        run.__name__ = TOOL_PREFIX + name
        return run

    def get_tools(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": TOOL_PREFIX + name,
                "description": TOOL_SPECS[name]["description"],
                "parameters": TOOL_SPECS[name]["parameters"],
                "handler": self._handler(name),
            }
            for name in TOOL_NAMES
        ]

    def execute(self, tool_name: str, arguments: Optional[Dict[str, Any]] = None) -> str:
        """Run a tool by its bridge name (``dominusnode_<tool>``) and return a JSON string."""
        name = tool_name[len(TOOL_PREFIX):] if tool_name.startswith(TOOL_PREFIX) else tool_name
        return self.call_json(name, arguments)

    @staticmethod
    def mcp_config(base_url: Optional[str] = None) -> Dict[str, Any]:
        return generate_mcp_config(base_url)
