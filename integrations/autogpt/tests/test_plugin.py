"""AutoGPT registration: exactly the 19 v2 commands, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from dominusnode_autogpt import TOOL_NAMES, DominusNodePlugin

KEY = "dn_live_" + "a1b2c3d4" * 4


def _plugin():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodePlugin(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    assert [c["name"] for c in DominusNodePlugin.get_commands()] == list(TOOL_NAMES)


def test_post_prompt_registers_all_commands():
    plugin, _ = _plugin()
    prompt = MagicMock()
    assert plugin.can_handle_post_prompt()
    plugin.post_prompt(prompt)
    assert [c.args[1] for c in prompt.add_command.call_args_list] == list(TOOL_NAMES)


def test_schemas_have_no_key():
    text = json.dumps(DominusNodePlugin.get_commands())
    assert KEY not in text and "api_key" not in text and '"self"' not in text
    fetch = DominusNodePlugin.get_commands()[0]["parameters"]
    assert fetch["required"] == ["url"] and fetch["properties"]["allow_http"]["type"] == "boolean"
    plugin, _ = _plugin()
    assert KEY not in repr(plugin)


def test_handle_command_routes_to_sdk():
    plugin, sdk = _plugin()
    sdk.network.stats.return_value = {"nodesOnline": 12}
    out = plugin.handle_command("dominusnode_network_stats", {})
    sdk.network.stats.assert_called_once()
    assert "12" in out


def test_handle_command_rejects_unknown_and_key_args():
    plugin, sdk = _plugin()
    assert plugin.handle_command("dominusnode_topup_stripe", {}).startswith("Error:")
    out = plugin.handle_command("dominusnode_balance", {"api_key": KEY})
    assert out.startswith("Error:") and KEY not in out
    sdk.wallet.get_balance.assert_not_called()


def test_handle_command_scrubs_errors():
    plugin, sdk = _plugin()
    sdk.usage.get.side_effect = RuntimeError("bad " + KEY)
    out = plugin.handle_command("dominusnode_usage", {"since": "2026-01-01"})
    sdk.usage.get.assert_called_once_with(from_="2026-01-01", to=None)
    assert out.startswith("Error:") and KEY not in out
