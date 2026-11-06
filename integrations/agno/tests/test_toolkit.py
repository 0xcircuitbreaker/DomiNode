"""Agno registration: exactly the 19 v2 tools, schemas free of credentials."""

import json
from unittest.mock import MagicMock

from agno.tools import Toolkit

from dominusnode_agno import TOOL_NAMES, DominusNodeToolkit

KEY = "dn_live_" + "a1b2c3d4" * 4


def _toolkit():
    sdk = MagicMock()
    sdk.is_connected = False
    return DominusNodeToolkit(api_key=KEY, client=sdk), sdk


def test_registration_matches_standard_set():
    tk, _ = _toolkit()
    assert isinstance(tk, Toolkit) and tk.name == "dominusnode"
    assert list(tk.functions) == list(TOOL_NAMES)


def test_schemas_have_no_key():
    tk, _ = _toolkit()
    for f in tk.functions.values():
        f.process_entrypoint()
        schema = json.dumps(f.to_dict())
        assert KEY not in schema and "api_key" not in schema
        assert f.description
    fetch = tk.functions["dominusnode_fetch"]
    assert "url" in fetch.parameters["properties"] and "self" not in fetch.parameters["properties"]
    assert KEY not in repr(tk)


def test_entrypoint_routes_to_sdk():
    tk, sdk = _toolkit()
    sdk.x402.get_info.return_value = {"enabled": True}
    out = tk.functions["dominusnode_x402_info"].entrypoint()
    sdk.x402.get_info.assert_called_once()
    assert "enabled" in out


def test_entrypoint_args_and_scrubbed_error():
    tk, sdk = _toolkit()
    sdk.payouts.list.side_effect = RuntimeError("bad " + KEY)
    out = tk.functions["dominusnode_payouts_list"].entrypoint(limit=2)
    sdk.payouts.list.assert_called_once_with(limit=2, offset=0)
    assert out.startswith("Error:") and KEY not in out
