"""CrewAI tools for the DominusNode AI-agent relay network (v2).

Example::

    from dominusnode_crewai import DominusNodeToolkit

    tools = DominusNodeToolkit().get_tools()   # reads DOMINUSNODE_API_KEY
"""

from ._core import TOOL_NAMES, DominusNodeTools
from .tools import DominusNodeTool, DominusNodeToolkit, build_tools

__version__ = "2.0.0"

__all__ = ["DominusNodeToolkit", "DominusNodeTool", "DominusNodeTools", "build_tools", "TOOL_NAMES", "__version__"]
