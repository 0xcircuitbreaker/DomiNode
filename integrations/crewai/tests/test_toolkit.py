"""CrewAI registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from crewai.tools import BaseTool

from dominusnode_crewai import TOOL_NAMES, DominusNodeToolkit

KEY = "dn_live_" + "a1b2c3d4" * 4


def _toolkit():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolkit(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    tk, _ = _toolkit()
    tools = tk.get_tools()
    assert [t.name for t in tools] == list(TOOL_NAMES)
    assert all(isinstance(t, BaseTool) for t in tools)


def test_schemas_have_no_key():
    tk, _ = _toolkit()
    for t in tk.get_tools():
        schema = json.dumps(t.args_schema.model_json_schema())
        assert KEY not in schema and "api_key" not in schema
        assert KEY not in t.description
        assert KEY not in t.model_dump_json()
    assert KEY not in repr(tk)


def test_run_routes_to_sdk():
    tk, sdk = _toolkit()
    sdk.nodes.tier.return_value = {"tier": "probation"}
    tool = {t.name: t for t in tk.get_tools()}["dominusnode_node_tier"]
    out = tool.run()
    sdk.nodes.tier.assert_called_once()
    assert "probation" in out


def test_run_with_args_and_scrubbed_error():
    tk, sdk = _toolkit()
    sdk.wallet.get_crypto_status.side_effect = RuntimeError("bad " + KEY)
    tool = {t.name: t for t in tk.get_tools()}["dominusnode_check_payment"]
    out = tool.run(invoice_id="11111111-1111-1111-1111-111111111111")
    sdk.wallet.get_crypto_status.assert_called_once_with("11111111-1111-1111-1111-111111111111")
    assert out.startswith("Error:") and KEY not in out
