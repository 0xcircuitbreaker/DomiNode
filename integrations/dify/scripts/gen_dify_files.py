"""Regenerate provider/, tools/ YAML and tool sources from TOOL_SPECS.

Run from integrations/dify:  python scripts/gen_dify_files.py
"""

from __future__ import annotations

import pathlib

import yaml

from dominusnode_dify._core import TOOL_NAMES, TOOL_SPECS

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _label(name: str) -> str:
    return name.replace("_", " ").title().replace("X402", "x402")


def _param(name: str, schema: dict, required: bool) -> dict:
    t = schema.get("type")
    p: dict = {"name": name, "label": {"en_US": _label(name)},
               "human_description": {"en_US": schema.get("description", "")},
               "llm_description": schema.get("description", ""), "required": required, "form": "llm"}
    if "enum" in schema:
        p["type"] = "select"
        p["options"] = [{"value": v, "label": {"en_US": v}} for v in schema["enum"]]
    elif t == "integer":
        p["type"] = "number"
    elif t == "boolean":
        p["type"] = "boolean"
    else:
        p["type"] = "string"
    if "default" in schema:
        p["default"] = schema["default"]
    return p


def main() -> None:
    (ROOT / "tools").mkdir(exist_ok=True)
    for name in TOOL_NAMES:
        spec = TOOL_SPECS[name]
        props = spec["parameters"]["properties"]
        req = set(spec["parameters"]["required"])
        doc = {
            "identity": {"name": name, "author": "dominusnode", "label": {"en_US": _label(name)}},
            "description": {"human": {"en_US": spec["description"].split(". ")[0] + "."}, "llm": spec["description"]},
            "parameters": [_param(k, v, k in req) for k, v in props.items()],
            "extra": {"python": {"source": f"tools/{name}.py"}},
        }
        (ROOT / "tools" / f"{name}.yaml").write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True))
        cls = "".join(w.title() for w in name.split("_")) + "Tool"
        (ROOT / "tools" / f"{name}.py").write_text(
            f'from dominusnode_dify import plugin\n\n\nclass {cls}(plugin.DominusNodeTool):\n    TOOL = "{name}"\n'
        )
    provider = yaml.safe_load((ROOT / "provider" / "dominusnode.yaml").read_text())
    provider["tools"] = [f"tools/{n}.yaml" for n in TOOL_NAMES]
    (ROOT / "provider" / "dominusnode.yaml").write_text(yaml.safe_dump(provider, sort_keys=False, allow_unicode=True))


if __name__ == "__main__":
    main()
