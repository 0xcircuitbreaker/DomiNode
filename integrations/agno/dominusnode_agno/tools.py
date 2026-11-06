"""Agno toolkit exposing the 19 standard DominusNode v2 tools."""

from typing import Any, Optional

from agno.tools import Toolkit

from ._core import DominusNodeTools


class DominusNodeToolkit(Toolkit):
    """DominusNode relay-network tools for Agno agents.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or passed as config); it is never a
    tool argument and never appears in tool output.

    Example::

        from agno.agent import Agent
        agent = Agent(model=model, tools=[DominusNodeToolkit()])
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
        **kwargs: Any,
    ) -> None:
        self._core = DominusNodeTools(
            api_key=api_key, base_url=base_url, proxy_host=proxy_host, http_proxy_port=http_proxy_port, client=client
        )
        super().__init__(name="dominusnode", tools=self._core.tool_functions(), **kwargs)

    def __repr__(self) -> str:
        return "DominusNodeToolkit()"
