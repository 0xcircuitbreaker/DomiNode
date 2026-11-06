"""Shared runtime for the DominusNode TaskWeaver plugins.

Every plugin in ``plugins/`` is a thin ``taskweaver.plugin.Plugin`` whose
``__call__`` forwards to :func:`run`. One ``DominusNodeTools`` (one SDK
client) is shared per base URL. The API key is read from
``DOMINUSNODE_API_KEY``; it is never a plugin parameter.
"""

from __future__ import annotations

import threading
from typing import Any, Dict, Mapping, Optional, Tuple

from dominusnode_taskweaver._core import DominusNodeTools

_lock = threading.Lock()
_cache: Dict[Tuple[Optional[str], Optional[str]], DominusNodeTools] = {}


def get_tools(config: Optional[Mapping[str, Any]] = None) -> DominusNodeTools:
    cfg = config or {}
    base_url = cfg.get("base_url") or None
    proxy_host = cfg.get("proxy_host") or None
    with _lock:
        tools = _cache.get((base_url, proxy_host))
        if tools is None:
            tools = DominusNodeTools(base_url=base_url, proxy_host=proxy_host)
            _cache[(base_url, proxy_host)] = tools
        return tools


def set_tools(tools: Optional[DominusNodeTools]) -> None:
    """Install (or clear, with None) a shared instance; used by host apps and tests."""
    with _lock:
        _cache.clear()
        if tools is not None:
            _cache[(None, None)] = tools


def run(plugin: Any, tool: str, kwargs: Dict[str, Any]) -> str:
    config = getattr(plugin, "config", None)
    return get_tools(config if isinstance(config, Mapping) else None).call(tool, kwargs)
