"""LangChain registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from dominusnode_langchain import TOOL_NAMES, DominusNodeToolkit

KEY = "dn_live_" + "a1b2c3d4" * 4


def _toolkit():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolkit(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    tk, _ = _toolkit()
    names = [t.name for t in tk.get_tools()]
    assert names == list(TOOL_NAMES)


def test_schemas_have_no_key():
    tk, _ = _toolkit()
    for t in tk.get_tools():
        schema = json.dumps(t.args_schema.model_json_schema())
        assert KEY not in schema and "api_key" not in schema
        assert KEY not in t.description and t.description
    assert KEY not in repr(tk)


def test_invoke_routes_to_sdk():
    tk, sdk = _toolkit()
    sdk.network.pricing.return_value = {"residential": {"musd": "5000000"}}
    tool = {t.name: t for t in tk.get_tools()}["dominusnode_network_pricing"]
    out = tool.invoke({})
    sdk.network.pricing.assert_called_once()
    assert "5000000" in out


def test_invoke_with_args_and_scrubbed_error():
    tk, sdk = _toolkit()
    sdk.wallet.top_up_crypto.side_effect = RuntimeError("bad " + KEY)
    tool = {t.name: t for t in tk.get_tools()}["dominusnode_topup_crypto"]
    out = tool.invoke({"amount_cents": 1000, "currency": "btc"})
    sdk.wallet.top_up_crypto.assert_called_once_with(1000, "btc")
    assert out.startswith("Error:") and KEY not in out
