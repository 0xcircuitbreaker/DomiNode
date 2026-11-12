"""DominusNode relay-network tools for IronClaw (v2, built on the dominusnode SDK)."""

from dominusnode_ironclaw._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_ironclaw.mcp_config import generate_mcp_config
from dominusnode_ironclaw.tools import TOOL_PREFIX, DominusNodeToolkit

__version__ = "2.1.0"
__all__ = ["DominusNodeToolkit", "generate_mcp_config", "TOOL_NAMES", "TOOL_SPECS", "TOOL_PREFIX", "__version__"]
