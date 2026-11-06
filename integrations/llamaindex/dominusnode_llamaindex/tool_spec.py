"""LlamaIndex ToolSpec exposing the 19 standard DominusNode v2 tools."""

from typing import Any, Optional

from llama_index.core.tools.tool_spec.base import BaseToolSpec

from ._core import TOOL_NAMES, DominusNodeTools


class DominusNodeToolSpec(DominusNodeTools, BaseToolSpec):
    """DominusNode relay-network tools for LlamaIndex agents.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or passed as config); it is never a
    tool argument and never appears in tool output.

    Example::

        from llama_index.core.agent.workflow import FunctionAgent

        agent = FunctionAgent(tools=DominusNodeToolSpec().to_tool_list(), llm=llm)
    """

    spec_functions = list(TOOL_NAMES)

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        proxy_host: Optional[str] = None,
        http_proxy_port: Optional[int] = None,
        client: Any = None,
    ) -> None:
        DominusNodeTools.__init__(
            self, api_key=api_key, base_url=base_url, proxy_host=proxy_host, http_proxy_port=http_proxy_port,
            client=client,
        )

    def __repr__(self) -> str:
        return "DominusNodeToolSpec()"

    __str__ = __repr__
