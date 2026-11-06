"""SuperAGI adapter tests (superagi BaseTool/BaseToolkit stubbed in conftest.py)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from dominusnode_superagi import DominusNodeToolkit, build_tools
from dominusnode_superagi._core import DominusNodeTools

from .test_core import KEY, STANDARD


def test_toolkit_registers_exactly_19() -> None:
    names = [t.name for t in DominusNodeToolkit().get_tools()]
    assert names == ["dominusnode_" + n for n in STANDARD]


def test_args_schemas_have_no_key_field() -> None:
    for t in build_tools():
        blob = json.dumps(t.args_schema.model_json_schema()).lower()
        assert "api_key" not in blob and "dn_live" not in blob


def test_execute_delegates_to_sdk() -> None:
    client = MagicMock()
    client.usage.get.return_value = {"totalBytes": 1}
    tools = {t.name: t for t in build_tools(DominusNodeTools(api_key=KEY, client=client))}
    out = tools["dominusnode_usage"]._execute(from_="2026-01-01", to=None)
    assert json.loads(out) == {"totalBytes": 1}
    client.usage.get.assert_called_once_with(from_="2026-01-01", to=None)


def test_execute_scrubs_errors() -> None:
    client = MagicMock()
    client.nodes.tier.side_effect = RuntimeError(f"bad {KEY}")
    tools = {t.name: t for t in build_tools(DominusNodeTools(api_key=KEY, client=client))}
    assert KEY not in tools["dominusnode_node_tier"]._execute()


def test_tool_config_key_is_used(monkeypatch) -> None:
    monkeypatch.setenv("DOMINUSNODE_API_KEY", KEY)
    tool = build_tools()[0]
    assert tool._core()._api_key == KEY


def test_env_keys_include_api_key() -> None:
    assert "DOMINUSNODE_API_KEY" in DominusNodeToolkit().get_env_keys()
