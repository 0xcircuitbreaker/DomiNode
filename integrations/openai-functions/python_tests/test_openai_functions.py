"""OpenAI Python handler tests: definitions match functions.json (TS parity), wrappers and handler behaviour."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from dominusnode_openai_functions import (
    chat_completion_tools,
    create_dominusnode_function_handler,
    function_definitions,
    responses_tools,
)

from .test_core import KEY, STANDARD

FUNCTIONS_JSON = Path(__file__).resolve().parent.parent / "functions.json"


def test_definitions_are_the_19_tools() -> None:
    assert [d["name"] for d in function_definitions()] == ["dominusnode_" + n for n in STANDARD]


def test_definitions_match_functions_json() -> None:
    assert function_definitions() == json.loads(FUNCTIONS_JSON.read_text())


def test_tool_wrappers() -> None:
    f0 = function_definitions()[0]
    assert chat_completion_tools()[0] == {"type": "function", "function": f0}
    assert responses_tools()[0] == {"type": "function", **f0}


def test_handler_accepts_raw_json_and_delegates() -> None:
    client = MagicMock()
    client.payouts.list.return_value = {"payouts": []}
    handle = create_dominusnode_function_handler(api_key=KEY, client=client)
    assert json.loads(handle("dominusnode_payouts_list", '{"limit": 2}')) == {"payouts": []}
    client.payouts.list.assert_called_once_with(limit=2, offset=None)


def test_handler_rejects_bad_args_and_scrubs() -> None:
    client = MagicMock()
    client.credits.balance.side_effect = RuntimeError(f"leak {KEY}")
    handle = create_dominusnode_function_handler(api_key=KEY, client=client)
    assert "error" in json.loads(handle("dominusnode_balance", "[1]"))
    assert "error" in json.loads(handle("dominusnode_balance", "{bad"))
    assert KEY not in handle("dominusnode_credits_balance", {})
