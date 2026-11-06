"""DominusNode relay-network tools for MetaGPT (v2, built on the dominusnode SDK)."""

from dominusnode_metagpt._core import TOOL_NAMES, TOOL_SPECS, DominusNodeToolkit
from dominusnode_metagpt.tools import TOOL_TAGS, DominusNodeTools, register

__version__ = "2.0.0"
__all__ = ["DominusNodeTools", "DominusNodeToolkit", "register", "TOOL_NAMES", "TOOL_SPECS", "TOOL_TAGS", "__version__"]
