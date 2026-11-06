"""Framework-free Dify provider: ``DominusNodeProvider(credentials={...}).invoke(tool, params)``."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from dominusnode_dify._core import TOOL_NAMES, DominusNodeToolkit


class DominusNodeProvider:
    """Dispatch the 19 standard tools with Dify-style dict parameters.

    ``credentials`` keys: ``api_key`` (falls back to ``DOMINUSNODE_API_KEY``),
    optional ``base_url`` and ``proxy_host``. Results are JSON-safe dicts; failures are
    ``{"error": "<scrubbed>"}``.
    """

    def __init__(self, credentials: Optional[Dict[str, Any]] = None, client: Any = None) -> None:
        creds = credentials or {}
        self._toolkit = DominusNodeToolkit(
            api_key=creds.get("api_key") or os.environ.get("DOMINUSNODE_API_KEY"),
            base_url=creds.get("base_url") or None,
            proxy_host=creds.get("proxy_host") or None,
            client=client,
        )

    def __repr__(self) -> str:
        return "DominusNodeProvider()"

    def invoke(self, tool_name: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._toolkit.call(tool_name, params or {})

    @staticmethod
    def get_tools() -> List[str]:
        return list(TOOL_NAMES)
