"""Inject mock superagi.tools.base_tool into sys.modules for testing.

This replaces the superagi/ stub directory with a pytest conftest that
injects the same BaseTool and BaseToolkit classes into the module system,
matching the pattern used by LangChain and CrewAI integrations.
"""

from __future__ import annotations

import os
import sys
from types import ModuleType
from typing import Any, Optional

from pydantic import BaseModel


class BaseTool(BaseModel):
    """Mock SuperAGI BaseTool."""

    name: str = ""
    description: str = ""
    args_schema: Any = None

    class Config:
        arbitrary_types_allowed = True

    def _execute(self, **kwargs: Any) -> str:
        raise NotImplementedError

    def get_tool_config(self, key: str) -> Optional[str]:
        """Get a tool configuration value.

        In the mock, falls back to environment variables.
        """
        return os.environ.get(key)


class BaseToolkit(BaseModel):
    """Mock SuperAGI BaseToolkit."""

    name: str = ""
    description: str = ""

    def get_tools(self) -> list:
        raise NotImplementedError

    def get_env_keys(self) -> list:
        raise NotImplementedError


_mod = ModuleType("superagi.tools.base_tool")
_mod.BaseTool = BaseTool  # type: ignore[attr-defined]
_mod.BaseToolkit = BaseToolkit  # type: ignore[attr-defined]

sys.modules.setdefault("superagi", ModuleType("superagi"))
sys.modules.setdefault("superagi.tools", ModuleType("superagi.tools"))
sys.modules.setdefault("superagi.tools.base_tool", _mod)
