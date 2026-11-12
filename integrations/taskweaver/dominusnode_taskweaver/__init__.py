"""DominusNode v2 plugins for Microsoft TaskWeaver.

The 19 plugins live in ``dominusnode_taskweaver/plugins`` (``.yaml`` + ``.py`` pairs);
copy them into your TaskWeaver project's ``plugins/`` directory.
"""

from pathlib import Path

from dominusnode_taskweaver._core import TOOL_NAMES, DominusNodeTools

PLUGIN_DIR = Path(__file__).parent / "plugins"

__version__ = "2.1.0"
__all__ = ["DominusNodeTools", "TOOL_NAMES", "PLUGIN_DIR"]
