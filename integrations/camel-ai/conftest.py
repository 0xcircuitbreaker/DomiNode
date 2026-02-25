"""Mock camel module before any test imports."""
import sys
from unittest.mock import MagicMock


class _MockFunctionTool:
    """Mock FunctionTool that wraps a callable."""

    def __init__(self, func):
        self.func = func
        self.name = func.__name__


# Create mock camel module hierarchy
camel_mock = MagicMock()
camel_toolkits_mock = MagicMock()
camel_toolkits_mock.FunctionTool = _MockFunctionTool
camel_mock.toolkits = camel_toolkits_mock

sys.modules.setdefault("camel", camel_mock)
sys.modules.setdefault("camel.toolkits", camel_toolkits_mock)
