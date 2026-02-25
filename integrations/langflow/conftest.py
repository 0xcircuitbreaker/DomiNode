"""Mock langchain_core module before any test imports."""
import sys
from unittest.mock import MagicMock

# Create mock langchain_core module hierarchy
lc_mock = MagicMock()
lc_tools_mock = MagicMock()


class StructuredTool:
    """Mock StructuredTool that supports isinstance checks."""

    def __init__(self, name="", description="", func=None, args_schema=None):
        self.name = name
        self.description = description
        self.func = func
        self.args_schema = args_schema

    @classmethod
    def from_function(cls, func=None, name="", description="", args_schema=None, **kwargs):
        return cls(name=name, description=description, func=func, args_schema=args_schema)


lc_tools_mock.StructuredTool = StructuredTool
lc_mock.tools = lc_tools_mock

sys.modules.setdefault("langchain_core", lc_mock)
sys.modules.setdefault("langchain_core.tools", lc_tools_mock)
