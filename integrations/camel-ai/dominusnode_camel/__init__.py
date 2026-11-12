"""CAMEL-AI tools for the DominusNode AI-agent relay network (v2).

Example::

    from dominusnode_camel import DominusNodeToolkit

    tools = DominusNodeToolkit().get_tools()   # reads DOMINUSNODE_API_KEY
"""

from ._core import TOOL_NAMES, DominusNodeTools
from .tools import DominusNodeToolkit

__version__ = "2.1.0"

__all__ = ["DominusNodeToolkit", "DominusNodeTools", "TOOL_NAMES", "__version__"]
