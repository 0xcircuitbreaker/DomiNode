"""MetaGPT tool registration for the DominusNode v2 standard tool set.

``DominusNodeTools`` is a plain class whose 19 methods return JSON strings and carry
Google-style docstrings, which is what MetaGPT's ``register_tool`` turns into tool
schemas. When MetaGPT is installed, importing :func:`register` (or calling it) adds the
class to MetaGPT's tool registry under the tag ``dominusnode``::

    from dominusnode_metagpt import register
    register()  # then e.g. DataInterpreter(tools=["DominusNodeTools"])
"""

from __future__ import annotations

import inspect
import json
from typing import Any, Callable, List, Optional

from dominusnode_metagpt._core import TOOL_NAMES, TOOL_SPECS
from dominusnode_metagpt._core import DominusNodeToolkit as _CoreToolkit

TOOL_TAGS: List[str] = ["dominusnode", "web", "proxy"]


def _docstring(name: str) -> str:
    spec = TOOL_SPECS[name]
    lines = [spec["description"], ""]
    props = spec["parameters"]["properties"]
    if props:
        lines.append("Args:")
        for arg, schema in props.items():
            lines.append(f"    {arg} ({schema.get('type', 'string')}): {schema.get('description', '')}")
        lines.append("")
    lines += ["Returns:", "    str: JSON result, or {\"error\": ...} on failure."]
    return "\n".join(lines)


def _wrap(name: str) -> Callable[..., str]:
    core = getattr(_CoreToolkit, name)

    def method(self: "DominusNodeTools", *args: Any, **kwargs: Any) -> str:
        return json.dumps(core(self, *args, **kwargs), ensure_ascii=False)

    method.__name__ = name
    method.__qualname__ = f"DominusNodeTools.{name}"
    method.__doc__ = _docstring(name)
    sig = inspect.signature(core)
    method.__signature__ = sig.replace(return_annotation=str)  # type: ignore[attr-defined]
    return method


class DominusNodeTools(_CoreToolkit):
    """DominusNode agent relay network: fetch web pages through agent-contributed exit nodes,
    read live pricing and network policy, check the prepaid wallet and usage, and earn credits by
    contributing an IP with the node agent. The API key comes from DOMINUSNODE_API_KEY.
    """


for _name in TOOL_NAMES:
    setattr(DominusNodeTools, _name, _wrap(_name))
del _name


def register(tags: Optional[List[str]] = None) -> type:
    """Register :class:`DominusNodeTools` (19 tools) with MetaGPT's tool registry."""
    from metagpt.tools.tool_registry import register_tool

    return register_tool(tags=tags or TOOL_TAGS, include_functions=list(TOOL_NAMES))(DominusNodeTools)
