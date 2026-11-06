"""Pydantic AI tools for the DominusNode v2 standard tool set.

Usage::

    from pydantic_ai import Agent
    from dominusnode_pydanticai import DominusNodeToolkit

    agent = Agent("openai:gpt-4o", toolsets=[DominusNodeToolkit().toolset()])
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from pydantic_ai import FunctionToolset, Tool

from dominusnode_pydanticai._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_pydanticai._core import DominusNodeToolkit as _CoreToolkit

TOOL_PREFIX = "dominusnode_"


class DominusNodeToolkit(_CoreToolkit):
    """The 19 DominusNode tools as Pydantic AI ``Tool`` objects / a ``FunctionToolset``.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` argument);
    it is never a tool parameter and never appears in a tool result.
    """

    def _handler(self, name: str) -> Callable[..., Dict[str, Any]]:
        def run(**kwargs: Any) -> Dict[str, Any]:
            return self.call(name, kwargs)

        run.__name__ = TOOL_PREFIX + name
        return run

    def tools(self) -> List[Tool[Any]]:
        """Return the 19 tools, usable as ``Agent(..., tools=toolkit.tools())``."""
        return [
            Tool.from_schema(
                self._handler(name),
                name=TOOL_PREFIX + name,
                description=TOOL_SPECS[name]["description"],
                json_schema=TOOL_SPECS[name]["parameters"],
            )
            for name in TOOL_NAMES
        ]

    def toolset(self) -> FunctionToolset[Any]:
        """Return the 19 tools as a ``FunctionToolset`` for ``Agent(..., toolsets=[...])``."""
        return FunctionToolset(self.tools())


def get_tools(api_key: Optional[str] = None, **kwargs: Any) -> List[Tool[Any]]:
    """Build a toolkit (API key from ``DOMINUSNODE_API_KEY`` by default) and return its tools."""
    return DominusNodeToolkit(api_key=api_key, **kwargs).tools()
