"""DominusNode v2 OpenAI-compatible function definitions and handler (Python).

With the ``openai`` SDK (Chat Completions)::

    from openai import OpenAI
    from dominusnode_openai_functions import chat_completion_tools, create_dominusnode_function_handler

    handle = create_dominusnode_function_handler()      # key from DOMINUSNODE_API_KEY
    resp = OpenAI().chat.completions.create(model="gpt-4.1", messages=messages, tools=chat_completion_tools())
    for call in resp.choices[0].message.tool_calls or []:
        content = handle(call.function.name, call.function.arguments)   # raw JSON string is accepted
        messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
"""

from __future__ import annotations

import copy
import json
from typing import Any, Callable, Dict, List, Optional, Union

from dominusnode_openai_functions._core import PREFIX, TOOL_NAMES, TOOL_SPECS, DominusNodeTools

_DANGEROUS = ("__proto__", "constructor", "prototype")


def function_definitions() -> List[Dict[str, Any]]:
    """The 19 tools as ``{name, description, parameters}`` JSON Schema definitions (same as functions.json)."""
    return [{"name": PREFIX + s["name"], "description": s["description"], "parameters": copy.deepcopy(s["parameters"])}
            for s in TOOL_SPECS]


def chat_completion_tools() -> List[Dict[str, Any]]:
    """Chat Completions ``tools=`` list."""
    return [{"type": "function", "function": f} for f in function_definitions()]


def responses_tools() -> List[Dict[str, Any]]:
    """Responses API ``tools=`` list."""
    return [{"type": "function", **f} for f in function_definitions()]


def create_dominusnode_function_handler(
    api_key: Optional[str] = None, base_url: Optional[str] = None, proxy_host: Optional[str] = None,
    client: Optional[Any] = None,
) -> Callable[..., str]:
    """``handler(name, args) -> JSON string``; ``args`` may be a dict or the model's raw JSON string."""
    tools = DominusNodeTools(api_key=api_key, base_url=base_url, proxy_host=proxy_host, client=client)

    def handler(name: str, args: Union[Dict[str, Any], str, None] = None) -> str:
        if isinstance(args, str):
            try:
                parsed = json.loads(args) if args.strip() else {}
            except ValueError:
                return json.dumps({"error": "arguments must be a JSON object"})
        else:
            parsed = args or {}
        if not isinstance(parsed, dict):
            return json.dumps({"error": "arguments must be a JSON object"})
        parsed = {k: v for k, v in parsed.items() if k not in _DANGEROUS}
        return tools.call(name, parsed)

    return handler


__version__ = "2.1.0"
__all__ = ["create_dominusnode_function_handler", "function_definitions", "chat_completion_tools", "responses_tools",
           "DominusNodeTools", "TOOL_NAMES", "__version__"]
