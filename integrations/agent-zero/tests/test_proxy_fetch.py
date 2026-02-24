"""Tests for proxy fetch, proxy config, and session listing tools.

All tests mock HTTP calls so no real network requests are made.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_mod = importlib.import_module("tools.01_proxy_fetch")
proxied_fetch = _mod.proxied_fetch
get_proxy_config = _mod.get_proxy_config
list_sessions = _mod.list_sessions


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_auth() -> MagicMock:
    """Create a mock DominusNodeAuth."""
    auth = MagicMock()
    auth.api_key = "dn_live_testkey123"
    auth.api_request.return_value = {"status": "ok"}
    auth.sanitize_error.side_effect = lambda msg: msg
    auth.url_encode.side_effect = lambda v: v
    return auth


# ---------------------------------------------------------------------------
# proxied_fetch tests
# ---------------------------------------------------------------------------


class TestProxiedFetch:
    """Tests for the proxied_fetch tool."""

    def test_rejects_missing_url(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {}))
        assert "error" in result
        assert "url" in result["error"].lower()

    def test_rejects_non_string_url(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {"url": 12345}))
        assert "error" in result

    def test_rejects_private_ip_url(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {"url": "http://192.168.1.1/admin"}))
        assert "error" in result
        assert "private" in result["error"].lower()

    def test_rejects_localhost_url(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {"url": "http://localhost/secret"}))
        assert "error" in result
        assert "localhost" in result["error"].lower() or "loopback" in result["error"].lower()

    def test_rejects_file_scheme(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {"url": "file:///etc/passwd"}))
        assert "error" in result
        assert "http" in result["error"].lower()

    def test_rejects_sanctioned_country(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {
            "url": "https://example.com",
            "country": "CU",
        }))
        assert "error" in result
        assert "OFAC" in result["error"]

    def test_rejects_post_method(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {
            "url": "https://example.com",
            "method": "POST",
        }))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_rejects_put_method(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {
            "url": "https://example.com",
            "method": "PUT",
        }))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_rejects_delete_method(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {
            "url": "https://example.com",
            "method": "DELETE",
        }))
        assert "error" in result
        assert "not allowed" in result["error"]

    def test_rejects_invalid_proxy_type(self):
        auth = _mock_auth()
        result = json.loads(proxied_fetch(auth, {
            "url": "https://example.com",
            "proxy_type": "mobile",
        }))
        assert "error" in result
        assert "dc" in result["error"] or "residential" in result["error"]

    def test_successful_fetch(self):
        auth = _mock_auth()

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "<html>Hello</html>"
        mock_response.content = b"<html>Hello</html>"
        mock_response.headers = {"content-type": "text/html"}

        mock_client_instance = MagicMock()
        mock_client_instance.request.return_value = mock_response
        mock_client_instance.__enter__ = MagicMock(return_value=mock_client_instance)
        mock_client_instance.__exit__ = MagicMock(return_value=False)

        with patch.object(_mod.httpx, "Client", return_value=mock_client_instance):
            result = json.loads(proxied_fetch(auth, {"url": "https://example.com"}))
        assert result["status"] == 200
        assert "Hello" in result["body"]

    def test_credential_scrubbing_in_error(self):
        auth = _mock_auth()
        # Trigger an error with the API key in the message
        with patch.object(
            _mod.httpx,
            "Client",
            side_effect=Exception("Connection to dn_live_testkey123@proxy failed"),
        ):
            result = json.loads(proxied_fetch(auth, {"url": "https://example.com"}))
            assert "error" in result
            assert "dn_live_testkey123" not in result["error"]
            assert "***" in result["error"]


# ---------------------------------------------------------------------------
# get_proxy_config tests
# ---------------------------------------------------------------------------


class TestGetProxyConfig:
    """Tests for the get_proxy_config tool."""

    def test_returns_config(self):
        auth = _mock_auth()
        auth.api_request.return_value = {
            "httpProxy": {"host": "proxy.dominusnode.com", "port": 8080}
        }
        result = json.loads(get_proxy_config(auth, {}))
        assert "httpProxy" in result

    def test_handles_api_error(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("API error 500: Internal")
        result = json.loads(get_proxy_config(auth, {}))
        assert "error" in result


# ---------------------------------------------------------------------------
# list_sessions tests
# ---------------------------------------------------------------------------


class TestListSessions:
    """Tests for the list_sessions tool."""

    def test_returns_sessions(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"sessions": []}
        result = json.loads(list_sessions(auth, {}))
        assert "sessions" in result

    def test_handles_api_error(self):
        auth = _mock_auth()
        auth.api_request.side_effect = RuntimeError("API error 401: Unauthorized")
        result = json.loads(list_sessions(auth, {}))
        assert "error" in result
