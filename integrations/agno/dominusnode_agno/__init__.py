"""Agno tools for the DominusNode AI-agent relay network (v2).

Example::

    from agno.agent import Agent
    from dominusnode_agno import DominusNodeToolkit

    agent = Agent(model=model, tools=[DominusNodeToolkit()])   # reads DOMINUSNODE_API_KEY
"""

from ._core import TOOL_NAMES, DominusNodeTools
from .tools import DominusNodeToolkit

__version__ = "2.2.0"

__all__ = ["DominusNodeToolkit", "DominusNodeTools", "TOOL_NAMES", "__version__"]
