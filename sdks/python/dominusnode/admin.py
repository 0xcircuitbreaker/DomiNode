"""Admin resource -- user management, revenue analytics, and system stats.

All admin endpoints require the authenticated user to have admin privileges.
"""

from __future__ import annotations

from typing import List, Optional
from urllib.parse import quote

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import (
    AdminUser,
    AdminUserDetail,
    AdminUsersResponse,
    DailyRevenue,
    Pagination,
    RevenueStats,
    SystemStats,
    UsagePeriod,
)


def _parse_admin_user(u: dict) -> AdminUser:
    return AdminUser(
        id=u["id"],
        email=u["email"],
        status=u["status"],
        plan_id=u.get("planId", "payg"),
        balance_cents=u.get("balanceCents", 0),
        created_at=str(u.get("createdAt", "")),
        is_admin=u.get("isAdmin", False),
    )


def _parse_admin_user_detail(u: dict) -> AdminUserDetail:
    return AdminUserDetail(
        id=u["id"],
        email=u["email"],
        status=u["status"],
        plan_id=u.get("planId", "payg"),
        balance_cents=u.get("balanceCents", 0),
        created_at=str(u.get("createdAt", "")),
        is_admin=u.get("isAdmin", False),
        api_key_count=u.get("apiKeyCount", 0),
        total_usage_bytes=u.get("totalUsageBytes", 0),
        total_spent_cents=u.get("totalSpentCents", 0),
        last_active=str(u["lastActive"]) if u.get("lastActive") else None,
    )


def _build_date_params(since: Optional[str], until: Optional[str]) -> dict:
    params: dict = {}
    if since:
        params["since"] = since
    if until:
        params["until"] = until
    return params


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class AdminResource:
    """Synchronous admin operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    # ── User Management ──────────────────────────────────────────────

    def list_users(self, *, page: int = 1, limit: int = 20) -> AdminUsersResponse:
        """List all users (paginated)."""
        data = self._http.get("/api/admin/users", params={"page": page, "limit": limit})
        users = [_parse_admin_user(u) for u in data.get("users", [])]
        p = data.get("pagination", {})
        pagination = Pagination(
            page=p.get("page", page),
            limit=p.get("limit", limit),
            total=p.get("total", 0),
            total_pages=p.get("totalPages", 0),
        )
        return AdminUsersResponse(users=users, pagination=pagination)

    def get_user(self, user_id: str) -> AdminUserDetail:
        """Get detailed information about a specific user."""
        data = self._http.get(f"/api/admin/users/{quote(user_id, safe='')}")
        return _parse_admin_user_detail(data["user"])

    def suspend_user(self, user_id: str) -> None:
        """Suspend a user account."""
        self._http.put(f"/api/admin/users/{quote(user_id, safe='')}/suspend")

    def activate_user(self, user_id: str) -> None:
        """Reactivate a suspended user account."""
        self._http.put(f"/api/admin/users/{quote(user_id, safe='')}/activate")

    def delete_user(self, user_id: str) -> None:
        """Soft-delete a user account."""
        self._http.delete(f"/api/admin/users/{quote(user_id, safe='')}")

    # ── Revenue Analytics ────────────────────────────────────────────

    def get_revenue(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> RevenueStats:
        """Get revenue statistics for the given period."""
        params = _build_date_params(since, until)
        data = self._http.get("/api/admin/revenue", params=params)
        period_data = data.get("period", {})
        return RevenueStats(
            total_revenue_cents=data.get("totalRevenueCents", 0),
            total_revenue_usd=data.get("totalRevenueUsd", 0),
            total_transactions=data.get("totalTransactions", 0),
            avg_transaction_cents=data.get("avgTransactionCents", 0),
            avg_transaction_usd=data.get("avgTransactionUsd", 0),
            top_up_count=data.get("topUpCount", 0),
            unique_paying_users=data.get("uniquePayingUsers", 0),
            period=UsagePeriod(
                since=period_data.get("since", ""),
                until=period_data.get("until", ""),
            ),
        )

    def get_daily_revenue(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> List[DailyRevenue]:
        """Get daily revenue breakdown."""
        params = _build_date_params(since, until)
        data = self._http.get("/api/admin/revenue/daily", params=params)
        return [
            DailyRevenue(
                date=d["date"],
                revenue_cents=d.get("revenueCents", 0),
                revenue_usd=d.get("revenueUsd", 0),
                transaction_count=d.get("transactionCount", 0),
            )
            for d in data.get("days", [])
        ]

    # ── System Stats ─────────────────────────────────────────────────

    def get_stats(self) -> SystemStats:
        """Get system-wide statistics."""
        data = self._http.get("/api/admin/stats")
        return SystemStats(
            total_users=data.get("totalUsers", 0),
            active_users=data.get("activeUsers", 0),
            suspended_users=data.get("suspendedUsers", 0),
            total_api_keys=data.get("totalApiKeys", 0),
            active_api_keys=data.get("activeApiKeys", 0),
            total_sessions=data.get("totalSessions", 0),
            active_sessions=data.get("activeSessions", 0),
        )


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncAdminResource:
    """Asynchronous admin operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list_users(self, *, page: int = 1, limit: int = 20) -> AdminUsersResponse:
        data = await self._http.get("/api/admin/users", params={"page": page, "limit": limit})
        users = [_parse_admin_user(u) for u in data.get("users", [])]
        p = data.get("pagination", {})
        pagination = Pagination(
            page=p.get("page", page),
            limit=p.get("limit", limit),
            total=p.get("total", 0),
            total_pages=p.get("totalPages", 0),
        )
        return AdminUsersResponse(users=users, pagination=pagination)

    async def get_user(self, user_id: str) -> AdminUserDetail:
        data = await self._http.get(f"/api/admin/users/{quote(user_id, safe='')}")
        return _parse_admin_user_detail(data["user"])

    async def suspend_user(self, user_id: str) -> None:
        await self._http.put(f"/api/admin/users/{quote(user_id, safe='')}/suspend")

    async def activate_user(self, user_id: str) -> None:
        await self._http.put(f"/api/admin/users/{quote(user_id, safe='')}/activate")

    async def delete_user(self, user_id: str) -> None:
        await self._http.delete(f"/api/admin/users/{quote(user_id, safe='')}")

    async def get_revenue(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> RevenueStats:
        params = _build_date_params(since, until)
        data = await self._http.get("/api/admin/revenue", params=params)
        period_data = data.get("period", {})
        return RevenueStats(
            total_revenue_cents=data.get("totalRevenueCents", 0),
            total_revenue_usd=data.get("totalRevenueUsd", 0),
            total_transactions=data.get("totalTransactions", 0),
            avg_transaction_cents=data.get("avgTransactionCents", 0),
            avg_transaction_usd=data.get("avgTransactionUsd", 0),
            top_up_count=data.get("topUpCount", 0),
            unique_paying_users=data.get("uniquePayingUsers", 0),
            period=UsagePeriod(
                since=period_data.get("since", ""),
                until=period_data.get("until", ""),
            ),
        )

    async def get_daily_revenue(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> List[DailyRevenue]:
        params = _build_date_params(since, until)
        data = await self._http.get("/api/admin/revenue/daily", params=params)
        return [
            DailyRevenue(
                date=d["date"],
                revenue_cents=d.get("revenueCents", 0),
                revenue_usd=d.get("revenueUsd", 0),
                transaction_count=d.get("transactionCount", 0),
            )
            for d in data.get("days", [])
        ]

    async def get_stats(self) -> SystemStats:
        data = await self._http.get("/api/admin/stats")
        return SystemStats(
            total_users=data.get("totalUsers", 0),
            active_users=data.get("activeUsers", 0),
            suspended_users=data.get("suspendedUsers", 0),
            total_api_keys=data.get("totalApiKeys", 0),
            active_api_keys=data.get("activeApiKeys", 0),
            total_sessions=data.get("totalSessions", 0),
            active_sessions=data.get("activeSessions", 0),
        )
