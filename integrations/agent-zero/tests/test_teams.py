"""Tests for team management tools.

All tests mock API calls so no real network requests are made.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_mod = importlib.import_module("tools.04_teams")
create_team = _mod.create_team
list_teams = _mod.list_teams
team_details = _mod.team_details
team_fund = _mod.team_fund
team_create_key = _mod.team_create_key
team_usage = _mod.team_usage
update_team = _mod.update_team
update_team_member_role = _mod.update_team_member_role


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

VALID_UUID = "12345678-1234-1234-1234-123456789abc"
VALID_USER_UUID = "abcdef01-2345-6789-abcd-ef0123456789"


def _mock_auth() -> MagicMock:
    """Create a mock DominusNodeAuth."""
    auth = MagicMock()
    auth.api_key = "dn_live_testkey123"
    auth.api_request.return_value = {"id": VALID_UUID, "name": "Test Team"}
    auth.sanitize_error.side_effect = lambda msg: msg
    auth.url_encode.side_effect = lambda v: v
    return auth


# ---------------------------------------------------------------------------
# create_team tests
# ---------------------------------------------------------------------------


class TestCreateTeam:
    """Tests for the create_team tool."""

    def test_valid_creation(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {"name": "My Team"}))
        assert "id" in result

    def test_rejects_missing_name(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {}))
        assert "error" in result
        assert "name" in result["error"]

    def test_rejects_long_name(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {"name": "x" * 101}))
        assert "error" in result
        assert "100" in result["error"]

    def test_rejects_control_chars_in_name(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {"name": "team\x07bell"}))
        assert "error" in result
        assert "control" in result["error"]

    def test_rejects_max_members_zero(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {
            "name": "Team",
            "max_members": 0,
        }))
        assert "error" in result
        assert "1 and 100" in result["error"]

    def test_rejects_max_members_over_100(self):
        auth = _mock_auth()
        result = json.loads(create_team(auth, {
            "name": "Team",
            "max_members": 101,
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# team_details tests
# ---------------------------------------------------------------------------


class TestTeamDetails:
    """Tests for the team_details tool."""

    def test_rejects_missing_team_id(self):
        auth = _mock_auth()
        result = json.loads(team_details(auth, {}))
        assert "error" in result
        assert "team_id" in result["error"]

    def test_rejects_invalid_uuid(self):
        auth = _mock_auth()
        result = json.loads(team_details(auth, {"team_id": "not-a-uuid"}))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_valid_team_id(self):
        auth = _mock_auth()
        result = json.loads(team_details(auth, {"team_id": VALID_UUID}))
        assert "id" in result


# ---------------------------------------------------------------------------
# team_fund tests
# ---------------------------------------------------------------------------


class TestTeamFund:
    """Tests for the team_fund tool."""

    def test_rejects_amount_below_minimum(self):
        auth = _mock_auth()
        result = json.loads(team_fund(auth, {
            "team_id": VALID_UUID,
            "amount_cents": 50,
        }))
        assert "error" in result
        assert "100" in result["error"]

    def test_rejects_amount_above_maximum(self):
        auth = _mock_auth()
        result = json.loads(team_fund(auth, {
            "team_id": VALID_UUID,
            "amount_cents": 2_000_000,
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# update_team tests
# ---------------------------------------------------------------------------


class TestUpdateTeam:
    """Tests for the update_team tool."""

    def test_rejects_no_fields(self):
        auth = _mock_auth()
        result = json.loads(update_team(auth, {"team_id": VALID_UUID}))
        assert "error" in result
        assert "At least one" in result["error"]

    def test_valid_name_update(self):
        auth = _mock_auth()
        result = json.loads(update_team(auth, {
            "team_id": VALID_UUID,
            "name": "New Name",
        }))
        assert "id" in result

    def test_rejects_empty_name(self):
        auth = _mock_auth()
        result = json.loads(update_team(auth, {
            "team_id": VALID_UUID,
            "name": "",
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# update_team_member_role tests
# ---------------------------------------------------------------------------


class TestUpdateTeamMemberRole:
    """Tests for the update_team_member_role tool."""

    def test_rejects_invalid_role(self):
        auth = _mock_auth()
        result = json.loads(update_team_member_role(auth, {
            "team_id": VALID_UUID,
            "user_id": VALID_USER_UUID,
            "role": "owner",
        }))
        assert "error" in result
        assert "member" in result["error"]
        assert "admin" in result["error"]

    def test_rejects_invalid_user_uuid(self):
        auth = _mock_auth()
        result = json.loads(update_team_member_role(auth, {
            "team_id": VALID_UUID,
            "user_id": "bad-uuid",
            "role": "admin",
        }))
        assert "error" in result
        assert "UUID" in result["error"]

    def test_valid_role_update(self):
        auth = _mock_auth()
        result = json.loads(update_team_member_role(auth, {
            "team_id": VALID_UUID,
            "user_id": VALID_USER_UUID,
            "role": "admin",
        }))
        assert "id" in result

    def test_rejects_missing_role(self):
        auth = _mock_auth()
        result = json.loads(update_team_member_role(auth, {
            "team_id": VALID_UUID,
            "user_id": VALID_USER_UUID,
        }))
        assert "error" in result

    def test_rejects_missing_user_id(self):
        auth = _mock_auth()
        result = json.loads(update_team_member_role(auth, {
            "team_id": VALID_UUID,
            "role": "member",
        }))
        assert "error" in result


# ---------------------------------------------------------------------------
# team_create_key tests
# ---------------------------------------------------------------------------


class TestTeamCreateKey:
    """Tests for the team_create_key tool."""

    def test_rejects_missing_label(self):
        auth = _mock_auth()
        result = json.loads(team_create_key(auth, {"team_id": VALID_UUID}))
        assert "error" in result
        assert "label" in result["error"]

    def test_rejects_control_chars_in_label(self):
        auth = _mock_auth()
        result = json.loads(team_create_key(auth, {
            "team_id": VALID_UUID,
            "label": "key\nnewline",
        }))
        assert "error" in result
        assert "control" in result["error"]


# ---------------------------------------------------------------------------
# team_usage tests
# ---------------------------------------------------------------------------


class TestTeamUsage:
    """Tests for the team_usage tool."""

    def test_rejects_invalid_limit(self):
        auth = _mock_auth()
        result = json.loads(team_usage(auth, {
            "team_id": VALID_UUID,
            "limit": 0,
        }))
        assert "error" in result

    def test_returns_transactions(self):
        auth = _mock_auth()
        auth.api_request.return_value = {"transactions": []}
        result = json.loads(team_usage(auth, {"team_id": VALID_UUID}))
        assert "transactions" in result
