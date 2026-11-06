"""Dify plugin classes (``dify_plugin`` SDK) backed by :class:`DominusNodeProvider`.

``tools/<name>.py`` each define one ``DominusNodeTool`` subclass, as Dify's loader
expects exactly one ``Tool`` subclass per source file.
"""

from __future__ import annotations

from collections.abc import Generator
from typing import Any, Dict

from dify_plugin import Tool, ToolProvider
from dify_plugin.entities.tool import ToolInvokeMessage
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from dominusnode_dify.provider import DominusNodeProvider


class DominusNodeTool(Tool):
    """Base for the 19 tools; subclasses set ``TOOL`` to the standard tool name."""

    TOOL: str = ""

    def _invoke(self, tool_parameters: Dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        provider = DominusNodeProvider(credentials=dict(self.runtime.credentials or {}))
        params = {k: v for k, v in (tool_parameters or {}).items() if v is not None and v != ""}
        yield self.create_json_message(provider.invoke(self.TOOL, params))


class DominusNodeToolProvider(ToolProvider):
    def _validate_credentials(self, credentials: Dict[str, Any]) -> None:
        result = DominusNodeProvider(credentials=credentials).invoke("balance", {})
        if "error" in result:
            raise ToolProviderCredentialValidationError(result["error"])
