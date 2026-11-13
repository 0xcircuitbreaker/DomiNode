"""Gateway endpoint: TLS by default (production refuses plaintext 8080/1080)."""

import inspect
import json
from typing import Any, Dict

import pytest

from dominusnode_moltbook import _core as core

KEY = "dn_live_testkey1234567890abcdef"


def test_tls_is_the_default() -> None:
    g = core.resolve_gateway(env={})
    assert g == {"proxy_host": None, "http_port": None, "gateway_tls": {"port": 8443}}


def test_proxy_url_env_sets_host_and_self_host_port() -> None:
    g = core.resolve_gateway(env={"DOMINUSNODE_PROXY_URL": "https://Proxy.Example.org:8444"})
    assert g["proxy_host"] == "proxy.example.org" and g["gateway_tls"] == {"port": 8444}
    assert core.resolve_gateway(env={"DOMINUSNODE_PROXY_TLS_PORT": "8444"})["gateway_tls"] == {"port": 8444}
    assert core.resolve_gateway(tls_port=9443, env={})["gateway_tls"] == {"port": 9443}
    with pytest.raises(ValueError):
        core.resolve_gateway(env={"DOMINUSNODE_PROXY_URL": "http://gw.example:8080"})
    with pytest.raises(ValueError):
        core.resolve_gateway(env={"DOMINUSNODE_PROXY_URL": "https://u:p@gw.example"})


def test_plaintext_only_when_asked() -> None:
    g = core.resolve_gateway(env={"DOMINUSNODE_PROXY_INSECURE": "1", "DOMINUSNODE_PROXY_PORT": "9080"})
    assert g["gateway_tls"] is False and g["http_port"] == 9080
    assert core.resolve_gateway(insecure=True, env={})["gateway_tls"] is False


def test_client_is_built_with_gateway_tls(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: Dict[str, Any] = {}

    class FakeClient:
        is_connected = False

        def __init__(self, **kw: Any) -> None:
            seen.update(kw)

        def connect_with_key(self, key: str) -> None:
            self.is_connected = True

    for k in ("DOMINUSNODE_PROXY_URL", "DOMINUSNODE_PROXY_INSECURE", "DOMINUSNODE_PROXY_TLS_PORT", "DOMINUSNODE_PROXY_HOST"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(core, "DominusNodeClient", FakeClient)
    cls = next(c for _, c in inspect.getmembers(core, inspect.isclass) if c.__module__ == core.__name__ and hasattr(c, "_sdk"))
    cls(api_key=KEY)._sdk()
    assert seen["gateway_tls"] == {"port": 8443}


def test_node_guide_uses_the_published_image() -> None:
    text = core.NODE_SETUP_GUIDE if isinstance(core.NODE_SETUP_GUIDE, str) else json.dumps(core.NODE_SETUP_GUIDE)
    assert "ghcr.io/0xcircuitbreaker/dominusnode-node" in text
    assert "npm run build -w" not in text
