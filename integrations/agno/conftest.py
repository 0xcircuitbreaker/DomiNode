"""Mock agno module before any test imports."""
import sys
from unittest.mock import MagicMock

# Create mock agno module hierarchy
agno_mock = MagicMock()
agno_tools_mock = MagicMock()


# Toolkit base class mock that tracks registered functions
class _MockToolkit:
    def __init__(self, name="", instructions=""):
        self.name = name
        self.instructions = instructions
        self.functions = {}

    def register(self, func):
        self.functions[func.__name__] = func
        return func


agno_tools_mock.Toolkit = _MockToolkit
agno_mock.tools = agno_tools_mock

sys.modules.setdefault("agno", agno_mock)
sys.modules.setdefault("agno.tools", agno_tools_mock)
