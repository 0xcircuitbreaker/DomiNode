"""SuperAGI toolkit exposing the DominusNode v2 standard tool set (19 tools).

Each tool is a ``superagi.tools.base_tool.BaseTool`` with a pydantic
``args_schema`` and a ``_execute(**kwargs) -> str`` that delegates to the
``dominusnode`` SDK. The API key comes from SuperAGI tool configuration
(``DOMINUSNODE_API_KEY``) or the environment; it is never a tool argument.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Type

from pydantic import BaseModel, Field, create_model

from superagi.tools.base_tool import BaseTool, BaseToolkit

from dominusnode_superagi._core import PREFIX, TOOL_SPECS, DominusNodeTools

try:  # SuperAGI >= 0.0.14
    from superagi.tools.base_tool import ToolConfiguration
    from superagi.types.key_type import ToolConfigKeyType
except ImportError:  # pragma: no cover - older SuperAGI / test stub
    ToolConfiguration = None  # type: ignore[assignment,misc]
    ToolConfigKeyType = None  # type: ignore[assignment,misc]

_PY_TYPES: Dict[str, Any] = {"string": str, "integer": int, "boolean": bool}


def _args_model(spec: Dict[str, Any]) -> Type[BaseModel]:
    props = spec["parameters"]["properties"]
    required = set(spec["parameters"]["required"])
    fields: Dict[str, Any] = {}
    for pname, p in props.items():
        py = _PY_TYPES[p["type"]]
        attr = "from_" if pname == "from" else pname
        if pname in required:
            fields[attr] = (py, Field(..., description=p["description"]))
        else:
            fields[attr] = (Optional[py], Field(None, description=p["description"]))
    model_name = "".join(w.capitalize() for w in spec["name"].split("_")) + "Input"
    return create_model(model_name, **fields)  # type: ignore[call-overload]


class DominusNodeTool(BaseTool):
    """One DominusNode tool; ``tool_id`` selects which of the 19 it runs."""

    name: str = ""
    description: str = ""
    args_schema: Type[BaseModel] = BaseModel
    tool_id: str = ""
    core: Any = None

    class Config:
        arbitrary_types_allowed = True

    def _core(self) -> DominusNodeTools:
        if self.core is None:
            try:
                key = self.get_tool_config("DOMINUSNODE_API_KEY")
            except Exception:  # noqa: BLE001 - no toolkit config bound yet
                key = None
            self.core = DominusNodeTools(api_key=key or None)
        return self.core

    def _execute(self, **kwargs: Any) -> str:
        if "from_" in kwargs:
            kwargs["from"] = kwargs.pop("from_")
        return self._core().call(self.tool_id, kwargs)


def build_tools(core: Optional[DominusNodeTools] = None) -> List[DominusNodeTool]:
    """Instantiate the 19 tools (optionally sharing one ``DominusNodeTools``)."""
    return [
        DominusNodeTool(name=PREFIX + s["name"], description=s["description"], args_schema=_args_model(s),
                        tool_id=s["name"], core=core)
        for s in TOOL_SPECS
    ]


class DominusNodeToolkit(BaseToolkit):
    name: str = "DominusNode Toolkit"
    description: str = (
        "Fetch the web through the DominusNode AI-agent relay network (live per-GB pricing via "
        "dominusnode_network_pricing), manage the prepaid crypto wallet, and earn by contributing IPs with the node agent."
    )

    def get_tools(self) -> List[BaseTool]:
        return list(build_tools())

    def get_env_keys(self) -> List[Any]:
        if ToolConfiguration is None:
            return ["DOMINUSNODE_API_KEY", "DOMINUSNODE_BASE_URL", "DOMINUSNODE_PROXY_HOST"]
        return [
            ToolConfiguration(key="DOMINUSNODE_API_KEY", key_type=ToolConfigKeyType.STRING, is_required=True, is_secret=True),
            ToolConfiguration(key="DOMINUSNODE_BASE_URL", key_type=ToolConfigKeyType.STRING, is_required=False, is_secret=False),
            ToolConfiguration(key="DOMINUSNODE_PROXY_HOST", key_type=ToolConfigKeyType.STRING, is_required=False, is_secret=False),
        ]
