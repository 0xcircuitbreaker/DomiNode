"""DominusNode v2 function declarations and handler for Google Gemini / Vertex AI (Python).

With the ``google-genai`` SDK::

    from google import genai
    from google.genai import types
    from dominusnode_gemini import create_dominusnode_function_handler, function_declarations

    handle = create_dominusnode_function_handler()      # key from DOMINUSNODE_API_KEY
    tool = types.Tool(function_declarations=function_declarations())
    resp = genai.Client().models.generate_content(
        model="gemini-2.5-flash", contents="What does a GB of residential relay cost?",
        config=types.GenerateContentConfig(tools=[tool]))
    for call in resp.function_calls or []:
        result = handle(call.name, call.args or {})    # JSON string -> send back as a function response
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from dominusnode_gemini._core import PREFIX, TOOL_NAMES, TOOL_SPECS, DominusNodeTools


def to_declaration(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Core spec -> Gemini FunctionDeclaration dict (uppercase types; no additionalProperties/min/max)."""
    props: Dict[str, Any] = {}
    for name, p in spec["parameters"]["properties"].items():
        s: Dict[str, Any] = {"type": p["type"].upper(), "description": p["description"]}
        if "enum" in p:
            s["format"] = "enum"
            s["enum"] = list(p["enum"])
        props[name] = s
    return {"name": PREFIX + spec["name"], "description": spec["description"],
            "parameters": {"type": "OBJECT", "properties": props, "required": list(spec["parameters"]["required"])}}


def function_declarations() -> List[Dict[str, Any]]:
    """The 19 tools as Gemini FunctionDeclaration dicts (accepted by ``types.Tool(function_declarations=...)``)."""
    return [to_declaration(s) for s in TOOL_SPECS]


def create_dominusnode_function_handler(
    api_key: Optional[str] = None, base_url: Optional[str] = None, proxy_host: Optional[str] = None,
    client: Optional[Any] = None,
) -> Callable[..., str]:
    """``handler(name, args) -> JSON string``. ``api_key`` defaults to DOMINUSNODE_API_KEY (host config only)."""
    tools = DominusNodeTools(api_key=api_key, base_url=base_url, proxy_host=proxy_host, client=client)

    def handler(name: str, args: Optional[Dict[str, Any]] = None) -> str:
        return tools.call(name, dict(args or {}))

    return handler


__version__ = "2.0.0"
__all__ = ["create_dominusnode_function_handler", "function_declarations", "to_declaration", "DominusNodeTools",
           "TOOL_NAMES", "__version__"]
