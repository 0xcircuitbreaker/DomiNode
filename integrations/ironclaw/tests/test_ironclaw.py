"""IronClaw adapter: bridge tool definitions, dispatch and MCP config."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from dominusnode_ironclaw import TOOL_NAMES, DominusNodeToolkit, generate_mcp_config

FAKE_KEY = "dn_live_" + "k" * 40


def _tk():
    sdk = MagicMock()
    return DominusNodeToolkit(api_key=FAKE_KEY, client=sdk), sdk


def test_registers_exactly_19_tools():
    tk, _ = _tk()
    tools = tk.get_tools()
    assert [t["name"] for t in tools] == ["dominusnode_" + n for n in TOOL_NAMES]
    for t in tools:
        assert set(t) == {"name", "description", "parameters", "handler"}
        assert callable(t["handler"]) and t["parameters"]["type"] == "object"


def test_handler_and_execute_dispatch():
    tk, sdk = _tk()
    sdk.nodes.list.return_value = {"nodes": [], "limit": 5, "offset": 0}
    h = {t["name"]: t["handler"] for t in tk.get_tools()}["dominusnode_node_list"]
    assert json.loads(h(limit=5))["limit"] == 5
    sdk.nodes.list.assert_called_once_with(limit=5, offset=None)
    sdk.x402.get_info.return_value = {"supported": True}
    assert json.loads(tk.execute("dominusnode_x402_info")) == {"supported": True}


def test_schemas_and_outputs_have_no_key():
    tk, sdk = _tk()
    text = json.dumps([{k: v for k, v in t.items() if k != "handler"} for t in tk.get_tools()])
    assert FAKE_KEY not in text and '"api_key"' not in text
    sdk.payouts.list.side_effect = Exception(f"oops {FAKE_KEY}")
    out = tk.execute("dominusnode_payouts_list")
    assert FAKE_KEY not in out and "[REDACTED]" in out


def test_mcp_config_references_env_and_no_agent_header(monkeypatch):
    monkeypatch.setenv("DOMINUSNODE_API_KEY", FAKE_KEY)
    cfg = generate_mcp_config()
    text = json.dumps(cfg)
    assert FAKE_KEY not in text
    assert "X-DominusNode-Agent" not in text
    assert cfg["server"]["transport"]["args"] == ["-y", "@dominusnode/mcp-server"]
    assert cfg["server"]["transport"]["env"]["DOMINUSNODE_API_KEY"] == "${DOMINUSNODE_API_KEY}"
