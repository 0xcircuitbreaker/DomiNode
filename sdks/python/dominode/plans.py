"""Plans resource -- list plans, get/change user plan."""

from __future__ import annotations

from typing import List, Optional

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import Plan, UserPlanInfo, UserPlanUsage


def _parse_plan(p: dict) -> Plan:
    return Plan(
        id=p["id"],
        name=p["name"],
        price_per_gb_cents=p["pricePerGbCents"],
        price_per_gb_usd=p["pricePerGbUsd"],
        monthly_bandwidth_bytes=p.get("monthlyBandwidthBytes", 0),
        monthly_bandwidth_gb=p.get("monthlyBandwidthGB"),
        is_default=p.get("isDefault", False),
    )


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class PlansResource:
    """Synchronous plans operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def list(self) -> List[Plan]:
        """List all available plans."""
        data = self._http.get("/api/plans")
        return [_parse_plan(p) for p in data.get("plans", [])]

    def get_user_plan(self) -> UserPlanInfo:
        """Get the current user's plan and monthly usage."""
        data = self._http.get("/api/plans/user/plan")
        plan = _parse_plan(data["plan"])
        u = data["usage"]
        usage = UserPlanUsage(
            monthly_usage_bytes=u["monthlyUsageBytes"],
            monthly_usage_gb=u["monthlyUsageGB"],
            limit_bytes=u["limitBytes"],
            limit_gb=u.get("limitGB"),
            percent_used=u.get("percentUsed"),
        )
        return UserPlanInfo(plan=plan, usage=usage)

    def change_plan(self, plan_id: str) -> Plan:
        """Change the current user's plan.

        Args:
            plan_id: The plan ID to switch to (e.g. 'payg', 'vol100', 'vol1tb').
        """
        data = self._http.put("/api/plans/user/plan", json={"planId": plan_id})
        return _parse_plan(data["plan"])


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncPlansResource:
    """Asynchronous plans operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def list(self) -> List[Plan]:
        data = await self._http.get("/api/plans")
        return [_parse_plan(p) for p in data.get("plans", [])]

    async def get_user_plan(self) -> UserPlanInfo:
        data = await self._http.get("/api/plans/user/plan")
        plan = _parse_plan(data["plan"])
        u = data["usage"]
        usage = UserPlanUsage(
            monthly_usage_bytes=u["monthlyUsageBytes"],
            monthly_usage_gb=u["monthlyUsageGB"],
            limit_bytes=u["limitBytes"],
            limit_gb=u.get("limitGB"),
            percent_used=u.get("percentUsed"),
        )
        return UserPlanInfo(plan=plan, usage=usage)

    async def change_plan(self, plan_id: str) -> Plan:
        data = await self._http.put("/api/plans/user/plan", json={"planId": plan_id})
        return _parse_plan(data["plan"])
