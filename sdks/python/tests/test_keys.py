"""Tests for the KeysResource (sync) -- create, list, revoke API keys."""

from __future__ import annotations

from unittest.mock import MagicMock

from dominusnode.keys import KeysResource
from dominusnode.types import ApiKey, CreatedApiKey


class TestKeysResource:
    """Tests for synchronous API key operations."""

    def _make_keys(self) -> tuple[KeysResource, MagicMock]:
        mock_http = MagicMock()
        keys = KeysResource(mock_http)
        return keys, mock_http

    def test_create_returns_created_api_key(self) -> None:
        keys, mock_http = self._make_keys()
        mock_http.post.return_value = {
            "key": "dn_live_abc123def456",
            "id": "k-1",
            "prefix": "dn_live_abc1",
            "label": "My Production Key",
            "created_at": "2024-06-01T12:00:00Z",
        }

        result = keys.create("My Production Key")
        assert isinstance(result, CreatedApiKey)
        assert result.key == "dn_live_abc123def456"
        assert result.id == "k-1"
        assert result.prefix == "dn_live_abc1"
        assert result.label == "My Production Key"
        mock_http.post.assert_called_once_with(
            "/api/keys",
            json={"label": "My Production Key"},
        )

    def test_create_uses_default_label(self) -> None:
        keys, mock_http = self._make_keys()
        mock_http.post.return_value = {
            "key": "dn_live_xyz",
            "id": "k-2",
            "prefix": "dn_live_xyz",
            "label": "Default",
            "created_at": "2024-06-01T12:00:00Z",
        }

        result = keys.create()
        assert result.label == "Default"
        mock_http.post.assert_called_once_with(
            "/api/keys",
            json={"label": "Default"},
        )

    def test_list_returns_api_keys(self) -> None:
        keys, mock_http = self._make_keys()
        mock_http.get.return_value = {
            "keys": [
                {
                    "id": "k-1",
                    "prefix": "dn_live_abc1",
                    "label": "Production",
                    "created_at": "2024-06-01T12:00:00Z",
                    "revoked_at": None,
                },
                {
                    "id": "k-2",
                    "prefix": "dn_live_xyz",
                    "label": "Staging",
                    "created_at": "2024-05-01T10:00:00Z",
                    "revoked_at": "2024-05-15T14:00:00Z",
                },
            ],
        }

        result = keys.list()
        assert len(result) == 2
        assert isinstance(result[0], ApiKey)
        assert result[0].id == "k-1"
        assert result[0].label == "Production"
        assert result[0].revoked_at is None
        assert result[1].revoked_at is not None

    def test_list_returns_empty_list(self) -> None:
        keys, mock_http = self._make_keys()
        mock_http.get.return_value = {"keys": []}

        result = keys.list()
        assert result == []

    def test_revoke_calls_delete_endpoint(self) -> None:
        keys, mock_http = self._make_keys()
        mock_http.delete.return_value = None

        keys.revoke("k-1")
        mock_http.delete.assert_called_once_with("/api/keys/k-1")
