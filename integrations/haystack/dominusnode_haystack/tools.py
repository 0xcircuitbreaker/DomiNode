"""Haystack ``Tool`` objects for the DominusNode v2 standard tool set."""

from __future__ import annotations

from typing import Any, Callable, List, Optional

from haystack.tools import Tool, Toolset

from dominusnode_haystack._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_haystack._core import DominusNodeToolkit as _CoreToolkit

TOOL_PREFIX = "dominusnode_"


class DominusNodeToolkit(_CoreToolkit):
    """The 19 DominusNode tools, exposed as Haystack ``Tool`` objects.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` argument);
    it is never a tool parameter and never appears in a tool result.
    """

    def _handler(self, name: str) -> Callable[..., str]:
        def run(**kwargs: Any) -> str:
            return self.call_json(name, kwargs)

        run.__name__ = TOOL_PREFIX + name
        return run

    def get_tools(self) -> List[Tool]:
        """Return the 19 tools for a Haystack ``Agent``, ``ChatGenerator`` or ``ToolInvoker``."""
        return [
            Tool(
                name=TOOL_PREFIX + name,
                description=TOOL_SPECS[name]["description"],
                parameters=TOOL_SPECS[name]["parameters"],
                function=self._handler(name),
            )
            for name in TOOL_NAMES
        ]

    def get_toolset(self) -> Toolset:
        """Return the 19 tools grouped in a Haystack ``Toolset``."""
        return Toolset(self.get_tools())


def get_tools(api_key: Optional[str] = None, **kwargs: Any) -> List[Tool]:
    """Build a toolkit (API key from ``DOMINUSNODE_API_KEY`` by default) and return its tools."""
    return DominusNodeToolkit(api_key=api_key, **kwargs).get_tools()
