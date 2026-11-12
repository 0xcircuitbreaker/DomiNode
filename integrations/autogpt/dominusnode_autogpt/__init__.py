"""AutoGPT plugin for the DominusNode AI-agent relay network (v2).

Exposes the 19 standard DominusNode tools as AutoGPT commands, built on the
``dominusnode`` Python SDK. The API key is read from ``DOMINUSNODE_API_KEY``
(or passed as config); it is never a command argument and never in output.

Example::

    from dominusnode_autogpt import DominusNodePlugin

    plugin = DominusNodePlugin()
    plugin.handle_command("dominusnode_network_pricing", {})
    plugin.handle_command("dominusnode_fetch", {"url": "https://example.com", "country": "US"})

Classic AutoGPT plugin hooks (``can_handle_post_prompt`` / ``post_prompt``) register
every command on the prompt generator via ``prompt.add_command``.
"""

import inspect
from typing import Any, Dict, List, Optional, get_type_hints

from ._core import TOOL_NAMES, DominusNodeTools, arg_docs, describe

__version__ = "2.1.0"
__all__ = ["DominusNodePlugin", "DominusNodeTools", "TOOL_NAMES", "__version__"]

_JSON_TYPES = {str: "string", int: "integer", bool: "boolean", float: "number"}


def _json_type(ann: Any) -> str:
    for py, js in _JSON_TYPES.items():
        if ann is py or py in getattr(ann, "__args__", ()):
            return js
    return "string"


class DominusNodePlugin(DominusNodeTools):
    """AutoGPT command plugin with the 19 DominusNode v2 commands."""

    _name = "DominusNode"
    _version = __version__
    _description = (
        "DominusNode AI-agent relay network: fetch the web through contributed exit IPs (pay per GB at "
        "live prices), manage the prepaid wallet, and earn by running a relay node."
    )

    def __repr__(self) -> str:
        return "DominusNodePlugin()"

    __str__ = __repr__

    # -- command discovery ------------------------------------------------

    @classmethod
    def get_commands(cls) -> List[Dict[str, Any]]:
        """Metadata for the 19 commands: name, description and JSON-schema parameters."""
        out: List[Dict[str, Any]] = []
        for name in TOOL_NAMES:
            fn = getattr(cls, name)
            docs = arg_docs(fn)
            hints = get_type_hints(fn)
            props: Dict[str, Any] = {}
            required: List[str] = []
            for pname, p in inspect.signature(fn).parameters.items():
                if pname == "self":
                    continue
                prop: Dict[str, Any] = {"type": _json_type(hints.get(pname, str)), "description": docs.get(pname, pname)}
                if p.default is inspect.Parameter.empty:
                    required.append(pname)
                elif p.default is not None:
                    prop["default"] = p.default
                props[pname] = prop
            out.append({
                "name": name,
                "description": describe(fn),
                "parameters": {"type": "object", "properties": props, "required": required},
            })
        return out

    # -- dispatch ---------------------------------------------------------

    def handle_command(self, name: str, args: Optional[Dict[str, Any]] = None) -> str:
        """Run a command by name with a dict of arguments; always returns a (scrubbed) string."""
        if name not in TOOL_NAMES:
            return self._clean(f"Error: unknown command {name!r}")
        fn = getattr(self, name)
        args = dict(args or {})
        allowed = set(inspect.signature(fn).parameters)
        unknown = sorted(set(args) - allowed)
        if unknown:
            return self._clean(f"Error: unexpected argument(s) for {name}: {', '.join(unknown)}")
        try:
            return fn(**args)
        except TypeError as exc:
            return self._err(exc)

    # -- classic AutoGPT plugin hooks ------------------------------------

    def can_handle_post_prompt(self) -> bool:
        return True

    def post_prompt(self, prompt: Any) -> Any:
        for cmd in self.get_commands():
            params = {k: v["type"] for k, v in cmd["parameters"]["properties"].items()}
            prompt.add_command(cmd["description"].splitlines()[0], cmd["name"], params, getattr(self, cmd["name"]))
        return prompt
