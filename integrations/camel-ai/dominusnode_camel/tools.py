"""CAMEL-AI toolkit exposing the 19 standard DominusNode v2 tools."""

from typing import Any, List, Optional

from camel.toolkits import BaseToolkit, FunctionTool

from ._core import DominusNodeTools


class DominusNodeToolkit(BaseToolkit):
    """DominusNode relay-network tools for CAMEL agents.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or passed as config); it is never a
    tool argument and never appears in tool output.

    Example::

        from camel.agents import ChatAgent
        agent = ChatAgent(system_message="...", tools=DominusNodeToolkit().get_tools())
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
        timeout: Optional[float] = None,
    ) -> None:
        super().__init__(timeout=timeout)
        self._core = DominusNodeTools(
            api_key=api_key, base_url=base_url, proxy_host=proxy_host, http_proxy_port=http_proxy_port, client=client
        )

    def get_tools(self) -> List[FunctionTool]:
        return [FunctionTool(fn) for fn in self._core.tool_functions()]

    def __repr__(self) -> str:
        return "DominusNodeToolkit()"
