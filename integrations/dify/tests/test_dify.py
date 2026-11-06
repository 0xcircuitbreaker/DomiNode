"""Dify adapter: provider dispatch, generated YAML, and real dify_plugin Tool classes."""

from __future__ import annotations

import importlib.util
import json
import pathlib
from unittest.mock import MagicMock

import pytest
import yaml

from dominusnode_dify import TOOL_NAMES, TOOL_SPECS, DominusNodeProvider

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAKE_KEY = "dn_live_" + "k" * 40


def test_provider_lists_exactly_19_tools():
    assert DominusNodeProvider.get_tools() == TOOL_NAMES
    prov = yaml.safe_load((ROOT / "provider" / "dominusnode.yaml").read_text())
    assert prov["tools"] == [f"tools/{n}.yaml" for n in TOOL_NAMES]
    assert sorted(p.stem for p in (ROOT / "tools").glob("*.yaml")) == sorted(TOOL_NAMES)


@pytest.mark.parametrize("name", TOOL_NAMES)
def test_tool_yaml_matches_spec(name):
    doc = yaml.safe_load((ROOT / "tools" / f"{name}.yaml").read_text())
    assert doc["identity"]["name"] == name
    assert doc["extra"]["python"]["source"] == f"tools/{name}.py"
    assert [p["name"] for p in doc["parameters"]] == list(TOOL_SPECS[name]["parameters"]["properties"])
    assert "api_key" not in json.dumps(doc) and FAKE_KEY not in json.dumps(doc)


def test_tool_yaml_validates_with_dify_plugin():
    from dify_plugin.entities.tool import ToolConfiguration

    for name in TOOL_NAMES:
        ToolConfiguration.model_validate(yaml.safe_load((ROOT / "tools" / f"{name}.yaml").read_text()))


def test_provider_dispatch_and_scrub():
    sdk = MagicMock()
    sdk.network.stats.return_value = {"onlineNodes": 3}
    p = DominusNodeProvider(credentials={"api_key": FAKE_KEY}, client=sdk)
    assert p.invoke("network_stats", {}) == {"onlineNodes": 3}
    sdk.connect_with_key.assert_called_once_with(FAKE_KEY)
    sdk.nodes.tier.side_effect = Exception(f"x {FAKE_KEY}")
    assert FAKE_KEY not in json.dumps(p.invoke("node_tier", {}))
    assert "error" in p.invoke("topup_stripe", {})


def _load_tool_class(name):
    path = ROOT / "tools" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"dn_tool_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    from dify_plugin import Tool
    from dify_plugin.core.utils.class_loader import get_subclasses_from_module

    classes = get_subclasses_from_module(mod, Tool)
    assert len(classes) == 1, "Dify needs exactly one Tool subclass per file"
    return classes[0]


def test_each_tool_source_has_one_tool_class():
    for name in TOOL_NAMES:
        assert _load_tool_class(name).TOOL == name


def test_dify_tool_invoke_yields_json(monkeypatch):
    from dify_plugin.entities.tool import ToolRuntime

    import dominusnode_dify._core as core

    sdk = MagicMock()
    sdk.wallet.top_up_crypto.return_value = {"invoiceId": "i"}
    monkeypatch.setattr(core, "DominusNodeClient", lambda **kw: sdk)
    cls = _load_tool_class("topup_crypto")
    tool = cls(runtime=ToolRuntime(credentials={"api_key": FAKE_KEY}, user_id="u", session_id="s"), session=MagicMock())
    msgs = list(tool._invoke({"amount_cents": 2000, "currency": "usdc"}))
    assert msgs[0].message.json_object == {"invoiceId": "i"}
    sdk.wallet.top_up_crypto.assert_called_once_with(2000, "usdc")
