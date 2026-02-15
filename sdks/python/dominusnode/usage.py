"""Usage resource -- usage stats, daily aggregation, top hosts, and CSV export."""

from __future__ import annotations

from typing import List, Optional

from .http_client import AsyncHttpClient, SyncHttpClient
from .types import (
    DailyUsage,
    TopHost,
    UsagePagination,
    UsagePeriod,
    UsageRecord,
    UsageResponse,
    UsageSummary,
)


def _parse_usage_response(data: dict) -> UsageResponse:
    s = data["summary"]
    summary = UsageSummary(
        total_bytes=s["totalBytes"],
        total_cost_cents=s["totalCostCents"],
        request_count=s["requestCount"],
        total_gb=s["totalGB"],
        total_cost_usd=s["totalCostUsd"],
    )

    records = [
        UsageRecord(
            id=r["id"],
            session_id=r["sessionId"],
            bytes_in=r["bytesIn"],
            bytes_out=r["bytesOut"],
            total_bytes=r["totalBytes"],
            cost_cents=r["costCents"],
            proxy_type=r.get("proxyType", ""),
            target_host=r.get("targetHost", ""),
            created_at=str(r.get("createdAt", "")),
        )
        for r in data.get("records", [])
    ]

    p = data.get("pagination", {})
    pagination = UsagePagination(
        limit=p.get("limit", 0),
        offset=p.get("offset", 0),
        total=p.get("total", 0),
    )

    pr = data.get("period", {})
    period = UsagePeriod(
        since=str(pr.get("since", "")),
        until=str(pr.get("until", "")),
    )

    return UsageResponse(
        summary=summary,
        records=records,
        pagination=pagination,
        period=period,
    )


def _build_date_params(
    since: Optional[str],
    until: Optional[str],
) -> dict:
    params: dict = {}
    if since:
        params["since"] = since
    if until:
        params["until"] = until
    return params


# ──────────────────────────────────────────────────────────────────────
# Sync
# ──────────────────────────────────────────────────────────────────────


class UsageResource:
    """Synchronous usage operations."""

    def __init__(self, http: SyncHttpClient) -> None:
        self._http = http

    def get(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> UsageResponse:
        """Get usage records with summary."""
        params = _build_date_params(since, until)
        params["limit"] = limit
        params["offset"] = offset
        data = self._http.get("/api/usage", params=params)
        return _parse_usage_response(data)

    def get_daily(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> List[DailyUsage]:
        """Get daily usage aggregation for charts."""
        params = _build_date_params(since, until)
        data = self._http.get("/api/usage/daily", params=params)
        return [
            DailyUsage(
                date=d["date"],
                total_bytes=d["totalBytes"],
                total_gb=d["totalGB"],
                total_cost_cents=d["totalCostCents"],
                total_cost_usd=d["totalCostUsd"],
                request_count=d["requestCount"],
            )
            for d in data.get("days", [])
        ]

    def get_top_hosts(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: int = 10,
    ) -> List[TopHost]:
        """Get top target hosts by bandwidth."""
        params = _build_date_params(since, until)
        params["limit"] = limit
        data = self._http.get("/api/usage/top-hosts", params=params)
        return [
            TopHost(
                target_host=h["targetHost"],
                total_bytes=h["totalBytes"],
                total_gb=h["totalGB"],
                request_count=h["requestCount"],
            )
            for h in data.get("hosts", [])
        ]

    def export_csv(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> str:
        """Export usage records as CSV text."""
        params = _build_date_params(since, until)
        resp = self._http.get_raw("/api/usage/export", params=params)
        return resp.text


# ──────────────────────────────────────────────────────────────────────
# Async
# ──────────────────────────────────────────────────────────────────────


class AsyncUsageResource:
    """Asynchronous usage operations."""

    def __init__(self, http: AsyncHttpClient) -> None:
        self._http = http

    async def get(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: int = 200,
        offset: int = 0,
    ) -> UsageResponse:
        params = _build_date_params(since, until)
        params["limit"] = limit
        params["offset"] = offset
        data = await self._http.get("/api/usage", params=params)
        return _parse_usage_response(data)

    async def get_daily(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> List[DailyUsage]:
        params = _build_date_params(since, until)
        data = await self._http.get("/api/usage/daily", params=params)
        return [
            DailyUsage(
                date=d["date"],
                total_bytes=d["totalBytes"],
                total_gb=d["totalGB"],
                total_cost_cents=d["totalCostCents"],
                total_cost_usd=d["totalCostUsd"],
                request_count=d["requestCount"],
            )
            for d in data.get("days", [])
        ]

    async def get_top_hosts(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
        limit: int = 10,
    ) -> List[TopHost]:
        params = _build_date_params(since, until)
        params["limit"] = limit
        data = await self._http.get("/api/usage/top-hosts", params=params)
        return [
            TopHost(
                target_host=h["targetHost"],
                total_bytes=h["totalBytes"],
                total_gb=h["totalGB"],
                request_count=h["requestCount"],
            )
            for h in data.get("hosts", [])
        ]

    async def export_csv(
        self,
        *,
        since: Optional[str] = None,
        until: Optional[str] = None,
    ) -> str:
        params = _build_date_params(since, until)
        resp = await self._http.get_raw("/api/usage/export", params=params)
        return resp.text
