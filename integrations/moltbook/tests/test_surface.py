"""Public surface tests: 19 tool definitions, callables delegate, no Moltbook posting/registration remains."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import dominusnode_moltbook as pkg
from dominusnode_moltbook import DominusNodeTools, make_tool_callables, tool_definitions

from .test_core import KEY, STANDARD

PKG_DIR = Path(pkg.__file__).parent


def test_definitions_are_exactly_19() -> None:
    assert [d["name"] for d in tool_definitions()] == ["dominusnode_" + n for n in STANDARD]


def test_callables_delegate_to_sdk() -> None:
    client = MagicMock()
    client.x402.get_info.return_value = {"enabled": True}
    fns = make_tool_callables(DominusNodeTools(api_key=KEY, client=client))
    assert sorted(fns) == sorted("dominusnode_" + n for n in STANDARD)
    assert json.loads(fns["dominusnode_x402_info"]()) == {"enabled": True}


def test_no_moltbook_write_or_signing_code_left() -> None:
    assert not hasattr(pkg, "MoltbookClient")
    src = "".join(p.read_text() for p in PKG_DIR.glob("*.py")).lower()
    for needle in ("create_post", "/api/register", "vote(", "eth_private_key", "x-signature", "submolt"):
        assert needle not in src, needle


def test_definitions_have_no_key_param() -> None:
    for d in tool_definitions():
        assert not set(d["parameters"]["properties"]) & {"api_key", "key", "token"}
