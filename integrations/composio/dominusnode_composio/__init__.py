"""Composio custom tools for the DominusNode AI-agent relay network (v2).

Example::

    from composio import Composio
    from dominusnode_composio import DominusNodeToolkit

    session = Composio().create(
        user_id="agent-1",
        experimental={"custom_toolkits": [DominusNodeToolkit().composio_toolkit()]},
    )
"""

from ._core import TOOL_NAMES, DominusNodeTools
from .tools import TOOLKIT_SLUG, DominusNodeToolkit, tool_slug

__version__ = "2.2.0"

__all__ = ["DominusNodeToolkit", "DominusNodeTools", "TOOL_NAMES", "TOOLKIT_SLUG", "tool_slug", "__version__"]
