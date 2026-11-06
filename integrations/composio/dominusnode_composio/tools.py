"""Composio custom toolkit exposing the 19 standard DominusNode v2 tools.

Uses Composio's in-process custom tools (``composio.experimental``): the tools run locally
next to the SDK, so the DominusNode API key never leaves this process.
"""

from typing import Any, Callable, Dict, List, Optional

from composio import ExperimentalToolkit

from ._core import TOOL_NAMES, DominusNodeTools, args_model, describe

TOOLKIT_SLUG = "DOMINUSNODE"
_PREFIX = "dominusnode_"


def tool_slug(tool_name: str) -> str:
    """``dominusnode_fetch`` -> ``FETCH`` (final Composio slug ``LOCAL_DOMINUSNODE_FETCH``)."""
    return tool_name[len(_PREFIX):].upper()


def _model_name(tool_name: str) -> str:
    return "".join(p.capitalize() for p in tool_name.split("_")) + "Input"


def _executor(fn: Callable[..., str], model: Any) -> Callable[..., Dict[str, Any]]:
    def execute(input, ctx):  # noqa: A002 - Composio's (input, ctx) signature
        result = fn(**input.model_dump())
        return {"result": result, "error": result.startswith("Error:")}

    execute.__annotations__ = {"input": model}
    execute.__name__ = fn.__name__
    return execute


class DominusNodeToolkit:
    """Builds a Composio ``ExperimentalToolkit`` with the 19 DominusNode tools.

    The API key is read from ``DOMINUSNODE_API_KEY`` (or passed as config); it is never a
    tool argument and never appears in tool output.

    Example::

        from composio import Composio

        composio = Composio()
        session = composio.create(
            user_id="agent-1",
            experimental={"custom_toolkits": [DominusNodeToolkit().composio_toolkit()]},
        )
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

    def composio_toolkit(self) -> ExperimentalToolkit:
        toolkit = ExperimentalToolkit(
            slug=TOOLKIT_SLUG,
            name="DominusNode",
            description=(
                "DominusNode AI-agent relay network: fetch the web through contributed exit IPs "
                "(pay per GB at live prices), manage the prepaid wallet, and earn by running a relay node."
            ),
        )
        for name in TOOL_NAMES:
            fn = getattr(self._core, name)
            model = args_model(fn, _model_name(name))
            toolkit.tool(slug=tool_slug(name), name=name, description=describe(fn))(_executor(fn, model))
        return toolkit

    def get_tools(self) -> List[Any]:
        """The 19 ``composio`` ``CustomTool`` definitions."""
        return list(self.composio_toolkit().tools)

    def __repr__(self) -> str:
        return "DominusNodeToolkit()"
