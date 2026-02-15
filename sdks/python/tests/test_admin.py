"""Tests for the AdminResource (sync) -- user management, revenue, system stats."""

from __future__ import annotations

from unittest.mock import MagicMock

from dominusnode.admin import AdminResource
from dominusnode.types import (
    AdminUser,
    AdminUserDetail,
    AdminUsersResponse,
    DailyRevenue,
    Pagination,
    RevenueStats,
    SystemStats,
)


class TestAdminResource:
    """Tests for synchronous admin operations."""

    def _make_admin(self) -> tuple[AdminResource, MagicMock]:
        mock_http = MagicMock()
        admin = AdminResource(mock_http)
        return admin, mock_http

    def test_list_users_returns_paginated_response(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "users": [
                {
                    "id": "u-1",
                    "email": "user1@test.com",
                    "status": "active",
                    "planId": "payg",
                    "balanceCents": 1000,
                    "createdAt": "2024-01-01",
                    "isAdmin": False,
                },
                {
                    "id": "u-2",
                    "email": "admin@test.com",
                    "status": "active",
                    "planId": "vol100",
                    "balanceCents": 50000,
                    "createdAt": "2024-01-01",
                    "isAdmin": True,
                },
            ],
            "pagination": {
                "page": 1,
                "limit": 20,
                "total": 2,
                "totalPages": 1,
            },
        }

        result = admin.list_users()
        assert isinstance(result, AdminUsersResponse)
        assert len(result.users) == 2
        assert isinstance(result.users[0], AdminUser)
        assert result.users[0].email == "user1@test.com"
        assert result.users[1].is_admin is True
        assert isinstance(result.pagination, Pagination)
        assert result.pagination.total == 2
        assert result.pagination.total_pages == 1

    def test_list_users_with_pagination_params(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "users": [],
            "pagination": {"page": 3, "limit": 5, "total": 15, "totalPages": 3},
        }

        admin.list_users(page=3, limit=5)
        mock_http.get.assert_called_once_with(
            "/api/admin/users",
            params={"page": 3, "limit": 5},
        )

    def test_get_user_returns_detail(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "user": {
                "id": "u-1",
                "email": "detail@test.com",
                "status": "active",
                "planId": "payg",
                "balanceCents": 2500,
                "createdAt": "2024-01-01",
                "isAdmin": False,
                "apiKeyCount": 3,
                "totalUsageBytes": 5000000000,
                "totalSpentCents": 2500,
                "lastActive": "2024-06-15T10:00:00Z",
            },
        }

        result = admin.get_user("u-1")
        assert isinstance(result, AdminUserDetail)
        assert result.id == "u-1"
        assert result.api_key_count == 3
        assert result.total_usage_bytes == 5000000000
        assert result.last_active == "2024-06-15T10:00:00Z"

    def test_suspend_user(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.put.return_value = None

        admin.suspend_user("u-bad")
        mock_http.put.assert_called_once_with("/api/admin/users/u-bad/suspend")

    def test_activate_user(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.put.return_value = None

        admin.activate_user("u-bad")
        mock_http.put.assert_called_once_with("/api/admin/users/u-bad/activate")

    def test_delete_user(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.delete.return_value = None

        admin.delete_user("u-bad")
        mock_http.delete.assert_called_once_with("/api/admin/users/u-bad")

    def test_get_revenue_returns_stats(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "totalRevenueCents": 100000,
            "totalRevenueUsd": 1000.0,
            "totalTransactions": 50,
            "avgTransactionCents": 2000,
            "avgTransactionUsd": 20.0,
            "topUpCount": 50,
            "uniquePayingUsers": 10,
            "period": {"since": "2024-06-01", "until": "2024-06-30"},
        }

        result = admin.get_revenue(since="2024-06-01", until="2024-06-30")
        assert isinstance(result, RevenueStats)
        assert result.total_revenue_cents == 100000
        assert result.total_revenue_usd == 1000.0
        assert result.total_transactions == 50
        assert result.unique_paying_users == 10
        assert result.period.since == "2024-06-01"

    def test_get_daily_revenue(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "days": [
                {
                    "date": "2024-06-01",
                    "revenueCents": 5000,
                    "revenueUsd": 50.0,
                    "transactionCount": 3,
                },
                {
                    "date": "2024-06-02",
                    "revenueCents": 8000,
                    "revenueUsd": 80.0,
                    "transactionCount": 5,
                },
            ],
        }

        result = admin.get_daily_revenue()
        assert len(result) == 2
        assert isinstance(result[0], DailyRevenue)
        assert result[0].date == "2024-06-01"
        assert result[0].revenue_cents == 5000
        assert result[1].transaction_count == 5

    def test_get_stats(self) -> None:
        admin, mock_http = self._make_admin()
        mock_http.get.return_value = {
            "totalUsers": 100,
            "activeUsers": 80,
            "suspendedUsers": 5,
            "totalApiKeys": 200,
            "activeApiKeys": 180,
            "totalSessions": 1000,
            "activeSessions": 25,
        }

        result = admin.get_stats()
        assert isinstance(result, SystemStats)
        assert result.total_users == 100
        assert result.active_users == 80
        assert result.suspended_users == 5
        assert result.active_sessions == 25
