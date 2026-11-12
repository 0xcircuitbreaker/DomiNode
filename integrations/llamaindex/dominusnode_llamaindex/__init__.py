"""LlamaIndex tools for the DominusNode AI-agent relay network (v2).

Example::

    from dominusnode_llamaindex import DominusNodeToolSpec

    tools = DominusNodeToolSpec().to_tool_list()   # reads DOMINUSNODE_API_KEY
"""

from ._core import TOOL_NAMES, DominusNodeTools
from .tool_spec import DominusNodeToolSpec

__version__ = "2.1.0"

__all__ = ["DominusNodeToolSpec", "DominusNodeTools", "TOOL_NAMES", "__version__"]
