"""Optional Langflow custom component exposing the 19 DominusNode tools.

Import this module only inside Langflow (it needs the ``langflow`` package). Drop it into
your Langflow components directory, or import :class:`DominusNodeToolsComponent`. Its
``Tools`` output connects to an Agent's tools input. The API key comes from the
``DOMINUSNODE_API_KEY`` environment variable of the Langflow server or the secret input.
"""

from __future__ import annotations

from langflow.custom import Component
from langflow.io import Output, SecretStrInput

from dominusnode_langflow.tools import DominusNodeToolkit


class DominusNodeToolsComponent(Component):
    display_name = "DominusNode Relay Tools"
    description = "Fetch through the DominusNode agent relay network, check prices, wallet, usage and node earnings (19 tools)."
    icon = "globe"
    name = "DominusNodeTools"

    inputs = [
        SecretStrInput(
            name="api_key",
            display_name="DominusNode API Key",
            info="Optional; defaults to the DOMINUSNODE_API_KEY environment variable.",
            required=False,
        ),
    ]
    outputs = [Output(display_name="Tools", name="tools", method="build_tools")]

    def build_tools(self) -> list:
        return DominusNodeToolkit(api_key=self.api_key or None).get_tools()
