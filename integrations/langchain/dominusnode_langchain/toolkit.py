"""LangChain toolkit exposing the 19 standard DominusNode v2 tools."""

from typing import Any, List, Optional

from langchain_core.tools import BaseTool, BaseToolkit, StructuredTool
from pydantic import ConfigDict, PrivateAttr

from ._core import TOOL_NAMES, DominusNodeTools, args_model, describe


def _model_name(tool_name: str) -> str:
    return "".join(p.capitalize() for p in tool_name.split("_")) + "Input"


def build_tools(core: DominusNodeTools) -> List[BaseTool]:
    """Wrap each core method as a LangChain ``StructuredTool``."""
    tools: List[BaseTool] = []
    for name in TOOL_NAMES:
        fn = getattr(core, name)
        tools.append(
            StructuredTool.from_function(
                func=fn,
                name=name,
                description=describe(fn),
                args_schema=args_model(fn, _model_name(name)),
                handle_tool_error=True,
            )
        )
    return tools


class DominusNodeToolkit(BaseToolkit):
    """DominusNode relay-network tools for LangChain agents.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or passed as config here); it is
    never a tool argument and never appears in tool output.

    Example::

        toolkit = DominusNodeToolkit()
        agent = create_agent(model, tools=toolkit.get_tools())
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    _core: DominusNodeTools = PrivateAttr()

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._core = DominusNodeTools(
            api_key=api_key, base_url=base_url, proxy_host=proxy_host, http_proxy_port=http_proxy_port, client=client
        )

    def get_tools(self) -> List[BaseTool]:
        return build_tools(self._core)

    def __repr__(self) -> str:
        return "DominusNodeToolkit()"
