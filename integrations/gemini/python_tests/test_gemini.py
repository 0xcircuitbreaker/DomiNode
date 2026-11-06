"""Gemini Python handler tests: declarations match functions.json (TS parity) and the handler delegates to the SDK."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from dominusnode_gemini import create_dominusnode_function_handler, function_declarations

from .test_core import KEY, STANDARD

FUNCTIONS_JSON = Path(__file__).resolve().parent.parent / "functions.json"


def test_declarations_are_the_19_tools() -> None:
    assert [d["name"] for d in function_declarations()] == ["dominusnode_" + n for n in STANDARD]


def test_declarations_match_functions_json() -> None:
    assert function_declarations() == json.loads(FUNCTIONS_JSON.read_text())


def test_declarations_use_gemini_types() -> None:
    for d in function_declarations():
        assert d["parameters"]["type"] == "OBJECT"
        for p in d["parameters"]["properties"].values():
            assert p["type"] in {"STRING", "INTEGER", "BOOLEAN"}


def test_handler_delegates_and_scrubs() -> None:
    client = MagicMock()
    client.nodes.tier.return_value = {"tier": "probation"}
    client.wallet.get_balance.side_effect = RuntimeError(f"leak {KEY}")
    handle = create_dominusnode_function_handler(api_key=KEY, client=client)
    assert json.loads(handle("dominusnode_node_tier", {})) == {"tier": "probation"}
    assert KEY not in handle("dominusnode_balance")
