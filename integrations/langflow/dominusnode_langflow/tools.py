"""LangChain ``StructuredTool`` objects for Langflow (DominusNode v2 standard tool set).

Langflow agents accept LangChain tools. Use :func:`get_tools` from a Langflow custom
component (see ``component.py``) or any LangChain agent.
"""

from __future__ import annotations

from typing import Any, Callable, List, Optional

from langchain_core.tools import StructuredTool

from dominusnode_langflow._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_langflow._core import DominusNodeToolkit as _CoreToolkit

TOOL_PREFIX = "dominusnode_"


class DominusNodeToolkit(_CoreToolkit):
    """The 19 DominusNode tools as LangChain ``StructuredTool`` objects (results are JSON strings).

    The API key is read from ``DOMINUSNODE_API_KEY`` (or the ``api_key`` argument);
    it is never a tool parameter and never appears in a tool result.
    """

    def _handler(self, name: str) -> Callable[..., str]:
        def run(**kwargs: Any) -> str:
            return self.call_json(name, {k: v for k, v in kwargs.items() if v is not None})

        run.__name__ = TOOL_PREFIX + name
        return run

    def get_tools(self) -> List[StructuredTool]:
        return [
            StructuredTool.from_function(
                func=self._handler(name),
                name=TOOL_PREFIX + name,
                description=TOOL_SPECS[name]["description"],
                args_schema=TOOL_SPECS[name]["parameters"],
            )
            for name in TOOL_NAMES
        ]


def get_tools(api_key: Optional[str] = None, **kwargs: Any) -> List[StructuredTool]:
    """Build a toolkit (API key from ``DOMINUSNODE_API_KEY`` by default) and return its tools."""
    return DominusNodeToolkit(api_key=api_key, **kwargs).get_tools()
