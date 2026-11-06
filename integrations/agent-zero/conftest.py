"""Stub Agent Zero's ``python.helpers.tool`` (Tool, Response) so tests run without an Agent Zero checkout."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from types import ModuleType
from typing import Any


@dataclass
class Response:
    message: str
    break_loop: bool
    additional: Any = None


class Tool:
    """Mirrors python.helpers.tool.Tool's constructor."""

    def __init__(self, agent: Any, name: str, method: Any, args: dict, message: str, loop_data: Any = None,
                 **kwargs: Any) -> None:
        self.agent = agent
        self.name = name
        self.method = method
        self.args = args
        self.message = message
        self.loop_data = loop_data

    async def execute(self, **kwargs: Any) -> Response:
        raise NotImplementedError


_mod = ModuleType("python.helpers.tool")
_mod.Tool = Tool  # type: ignore[attr-defined]
_mod.Response = Response  # type: ignore[attr-defined]
sys.modules.setdefault("python", ModuleType("python"))
sys.modules.setdefault("python.helpers", ModuleType("python.helpers"))
sys.modules["python.helpers.tool"] = _mod
