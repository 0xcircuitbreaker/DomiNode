"""Composio registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from composio import CustomTool, ExperimentalToolkit

from dominusnode_composio import TOOL_NAMES, DominusNodeToolkit, tool_slug

KEY = "dn_live_" + "a1b2c3d4" * 4


def _toolkit():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolkit(api_key=KEY, client=sdk), sdk


def _by_name(tk):
    return {t.name: t for t in tk.get_tools()}


def test_registration_matches_standard_set():
    tk, _ = _toolkit()
    ck = tk.composio_toolkit()
    assert isinstance(ck, ExperimentalToolkit) and ck.slug == "DOMINUSNODE"
    tools = tk.get_tools()
    assert all(isinstance(t, CustomTool) for t in tools)
    assert [t.name for t in tools] == list(TOOL_NAMES)
    assert [t.slug for t in tools] == [tool_slug(n) for n in TOOL_NAMES]
    assert tool_slug("dominusnode_fetch") == "FETCH"


def test_schemas_have_no_key():
    tk, _ = _toolkit()
    for t in tk.get_tools():
        text = json.dumps(t.input_schema)
        assert KEY not in text and "api_key" not in text and t.description
    assert "url" in _by_name(tk)["dominusnode_fetch"].input_schema["properties"]
    assert KEY not in repr(tk)


def test_execute_routes_to_sdk():
    tk, sdk = _toolkit()
    sdk.network.policy.return_value = {"ports": [80, 443]}
    t = _by_name(tk)["dominusnode_network_policy"]
    out = t.execute(t.input_params(), None)
    sdk.network.policy.assert_called_once()
    assert "443" in out["result"] and out["error"] is False


def test_execute_args_and_scrubbed_error():
    tk, sdk = _toolkit()
    sdk.credits.convert.side_effect = RuntimeError("bad " + KEY)
    t = _by_name(tk)["dominusnode_credits_convert"]
    out = t.execute(t.input_params(amount_musd="10000"), None)
    sdk.credits.convert.assert_called_once_with("10000", idempotency_key=None)
    assert out["error"] is True and KEY not in json.dumps(out)
