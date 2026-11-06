"""TaskWeaver plugin tests: generated yaml/py pairs match the 19 standard tools and delegate to the SDK."""

from __future__ import annotations

import importlib.util
import json
from unittest.mock import MagicMock

import pytest
import yaml

from dominusnode_taskweaver import PLUGIN_DIR, runtime
from dominusnode_taskweaver._core import DominusNodeTools
from dominusnode_taskweaver.generate_plugins import render_all

from .test_core import KEY, STANDARD

NAMES = ["dominusnode_" + n for n in STANDARD]


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"twplugin_{name}", PLUGIN_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    classes = [v for v in vars(mod).values() if isinstance(v, type) and v.__module__ == mod.__name__]
    assert len(classes) == 1
    return classes[0]


@pytest.fixture()
def client():
    c = MagicMock()
    runtime.set_tools(DominusNodeTools(api_key=KEY, client=c))
    yield c
    runtime.set_tools(None)


def test_plugin_dir_has_exactly_the_19_tools() -> None:
    yamls = sorted(p.stem for p in PLUGIN_DIR.glob("*.yaml"))
    pys = sorted(p.stem for p in PLUGIN_DIR.glob("*.py"))
    assert yamls == sorted(NAMES) and pys == sorted(NAMES)


def test_committed_plugins_match_generator() -> None:
    for fname, text in render_all().items():
        assert (PLUGIN_DIR / fname).read_text() == text, f"{fname} is stale: run generate_plugins"


@pytest.mark.parametrize("name", NAMES)
def test_yaml_is_valid_and_has_no_key(name: str) -> None:
    doc = yaml.safe_load((PLUGIN_DIR / f"{name}.yaml").read_text())
    assert doc["name"] == name and doc["enabled"] is True and doc["description"]
    params = {p["name"] for p in doc["parameters"]}
    assert not params & {"api_key", "key", "token", "password"}
    assert "api_key" not in doc.get("configurations", {})


@pytest.mark.parametrize("name", NAMES)
def test_plugin_signature_matches_yaml(name: str) -> None:
    import inspect

    cls = _load(name)
    doc = yaml.safe_load((PLUGIN_DIR / f"{name}.yaml").read_text())
    sig = inspect.signature(cls.__call__)
    assert sorted(list(sig.parameters)[1:]) == sorted(p["name"] for p in doc["parameters"])


def test_fetch_plugin_calls_sdk(client: MagicMock) -> None:
    resp = MagicMock(status=200, status_text="OK", headers={}, truncated=False)
    resp.text.return_value = "ok"
    client.proxy.fetch.return_value = resp
    plugin = _load("dominusnode_fetch")("dominusnode_fetch", None, {})
    out = json.loads(plugin(url="https://example.com", country="DE"))
    assert out["status"] == 200
    client.proxy.fetch.assert_called_once_with("https://example.com", method="GET", country="DE", ip_class=None,
                                               session_id=None, allow_http=False)


def test_usage_plugin_maps_from(client: MagicMock) -> None:
    client.usage.get.return_value = {"bytes": 0}
    plugin = _load("dominusnode_usage")("dominusnode_usage", None, {})
    plugin(from_="2026-01-01")
    client.usage.get.assert_called_once_with(from_="2026-01-01", to=None)


def test_plugin_errors_scrubbed(client: MagicMock) -> None:
    client.credits.balance.side_effect = RuntimeError(f"leak {KEY}")
    plugin = _load("dominusnode_credits_balance")("dominusnode_credits_balance", None, {})
    assert KEY not in plugin()
