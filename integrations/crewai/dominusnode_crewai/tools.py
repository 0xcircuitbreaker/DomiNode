"""CrewAI tools exposing the 19 standard DominusNode v2 tools."""

from typing import Any, Callable, List, Optional

from crewai.tools import BaseTool
from pydantic import PrivateAttr

from ._core import TOOL_NAMES, DominusNodeTools, args_model, describe


class DominusNodeTool(BaseTool):
    """One DominusNode tool; ``_run`` delegates to the SDK-backed core method."""

    _fn: Callable[..., str] = PrivateAttr()

    def __init__(self, fn: Callable[..., str], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._fn = fn

    def _run(self, **kwargs: Any) -> str:
        return self._fn(**kwargs)


def _model_name(tool_name: str) -> str:
    return "".join(p.capitalize() for p in tool_name.split("_")) + "Input"


def build_tools(core: DominusNodeTools) -> List[BaseTool]:
    tools: List[BaseTool] = []
    for name in TOOL_NAMES:
        fn = getattr(core, name)
        tools.append(
            DominusNodeTool(fn, name=name, description=describe(fn), args_schema=args_model(fn, _model_name(name)))
        )
    return tools


class DominusNodeToolkit:
    """Builds the 19 CrewAI tools. The API key comes from ``DOMINUSNODE_API_KEY`` or config.

    Example::

        agent = Agent(role="Researcher", goal="...", backstory="...",
                      tools=DominusNodeToolkit().get_tools())
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
    ) -> None:
        self._core = DominusNodeTools(
            api_key=api_key, base_url=base_url, proxy_host=proxy_host, http_proxy_port=http_proxy_port, client=client
        )

    def get_tools(self) -> List[BaseTool]:
        return build_tools(self._core)

    def __repr__(self) -> str:
        return "DominusNodeToolkit()"
