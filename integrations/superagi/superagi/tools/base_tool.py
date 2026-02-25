"""Mock SuperAGI base_tool module for local development and testing.

Provides minimal BaseTool and BaseToolkit stubs matching the SuperAGI API
so the DomiNode toolkit can be developed and tested without installing
the full SuperAGI framework.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class BaseTool(BaseModel):
    """Mock SuperAGI BaseTool.

    In the real SuperAGI framework, this provides tool registration,
    configuration access, and execution plumbing.
    """

    name: str = ""
    description: str = ""
    args_schema: Any = None

    class Config:
        arbitrary_types_allowed = True

    def _execute(self, **kwargs: Any) -> str:
        raise NotImplementedError

    def get_tool_config(self, key: str) -> Optional[str]:
        """Get a tool configuration value (from SuperAGI config store).

        In the mock, falls back to environment variables.
        """
        import os
        return os.environ.get(key)


class BaseToolkit(BaseModel):
    """Mock SuperAGI BaseToolkit.

    In the real SuperAGI framework, this registers a set of tools
    and declares required environment/config keys.
    """

    name: str = ""
    description: str = ""

    def get_tools(self) -> list:
        raise NotImplementedError

    def get_env_keys(self) -> list:
        raise NotImplementedError
