"""Shared runtime for the DominusNode Agent Zero tools.

Each file in ``python/tools/`` is an Agent Zero ``Tool`` whose ``execute``
forwards to :func:`execute`. The SDK client is synchronous, so calls run in a
worker thread. The API key is read from ``DOMINUSNODE_API_KEY`` only.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Dict, Optional

from dominusnode_agent_zero._core import DominusNodeTools

_lock = threading.Lock()
_tools: Optional[DominusNodeTools] = None


def get_tools() -> DominusNodeTools:
    global _tools
    with _lock:
        if _tools is None:
            _tools = DominusNodeTools()
        return _tools


def set_tools(tools: Optional[DominusNodeTools]) -> None:
    """Install (or clear) the shared instance; used by host apps and tests."""
    global _tools
    with _lock:
        _tools = tools


async def execute(tool: str, kwargs: Dict[str, Any]) -> str:
    return await asyncio.to_thread(get_tools().call, tool, dict(kwargs))
