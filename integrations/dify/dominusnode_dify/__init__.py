"""DominusNode relay-network tool provider for Dify (v2, built on the dominusnode SDK).

``DominusNodeProvider`` works without Dify; the ``dify_plugin`` classes live in
``dominusnode_dify.plugin`` (imported by ``provider/`` and ``tools/`` in the plugin package).
"""

from dominusnode_dify._core import TOOL_NAMES, TOOL_SPECS, DominusNodeToolkit
from dominusnode_dify.provider import DominusNodeProvider

__version__ = "2.2.0"
__all__ = ["DominusNodeProvider", "DominusNodeToolkit", "TOOL_NAMES", "TOOL_SPECS", "__version__"]
