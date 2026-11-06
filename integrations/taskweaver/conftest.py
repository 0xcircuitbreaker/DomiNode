"""Stub ``taskweaver.plugin`` (Plugin + register_plugin) so tests run without TaskWeaver installed."""

from __future__ import annotations

import sys
from types import ModuleType
from typing import Any, Dict, List

REGISTERED: List[type] = []


class Plugin:
    """Mirrors taskweaver.plugin.base.Plugin's constructor: (name, ctx, config)."""

    def __init__(self, name: str, ctx: Any, config: Dict[str, Any]) -> None:
        self.name = name
        self.ctx = ctx
        self.config = config

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


def register_plugin(cls: type) -> type:
    REGISTERED.append(cls)
    return cls


try:
    import taskweaver.plugin  # noqa: F401  (real TaskWeaver installed)
except ImportError:
    _mod = ModuleType("taskweaver.plugin")
    _mod.Plugin = Plugin  # type: ignore[attr-defined]
    _mod.register_plugin = register_plugin  # type: ignore[attr-defined]
    sys.modules.setdefault("taskweaver", ModuleType("taskweaver"))
    sys.modules["taskweaver.plugin"] = _mod
