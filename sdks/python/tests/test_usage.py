"""Tests for the UsageResource (sync) -- usage stats, daily, top hosts, CSV export."""

from __future__ import annotations

from unittest.mock import MagicMock

from dominode.usage import UsageResource
from dominode.types import DailyUsage, TopHost, UsageResponse, UsageSummary


class TestUsageResource:
    """Tests for synchronous usage operations."""

    def _make_usage(self) -> tuple[UsageResource, MagicMock]:
        mock_http = MagicMock()
        usage = UsageResource(mock_http)
        return usage, mock_http

    def test_get_returns_usage_response(self) -> None:
        usage, mock_http = self._make_usage()
        mock_http.get.return_value = {
            "summary": {
                "totalBytes": 1073741824,
                "totalCostCents": 500,
                "requestCount": 150,
                "totalGB": 1.0,
                "totalCostUsd": 5.0,
            },
            "records": [
                {
                    "id": "rec-1",
                    "sessionId": "sess-1",
                    "bytesIn": 500000,
                    "bytesOut": 100000,
                    "totalBytes": 600000,
                    "costCents": 1,
                    "proxyType": "http",
                    "targetHost": "example.com",
                    "createdAt": "2024-06-01T12:00:00Z",
                },
            ],
            "pagination": {"limit": 200, "offset": 0, "total": 1},
            "period": {"since": "2024-06-01", "until": "2024-06-30"},
        }

        result = usage.get()
        assert isinstance(result, UsageResponse)
        assert isinstance(result.summary, UsageSummary)
        assert result.summary.total_bytes == 1073741824
        assert result.summary.total_gb == 1.0
        assert result.summary.total_cost_cents == 500
        assert result.summary.request_count == 150
        assert len(result.records) == 1
        assert result.records[0].target_host == "example.com"
        assert result.pagination.total == 1
        assert result.period.since == "2024-06-01"

    def test_get_with_date_range(self) -> None:
        usage, mock_http = self._make_usage()
        mock_http.get.return_value = {
            "summary": {
                "totalBytes": 0,
                "totalCostCents": 0,
                "requestCount": 0,
                "totalGB": 0,
                "totalCostUsd": 0,
            },
            "records": [],
            "pagination": {"limit": 200, "offset": 0, "total": 0},
            "period": {"since": "2024-06-15", "until": "2024-06-20"},
        }

        result = usage.get(since="2024-06-15", until="2024-06-20", limit=50, offset=10)
        mock_http.get.assert_called_once_with(
            "/api/usage",
            params={"since": "2024-06-15", "until": "2024-06-20", "limit": 50, "offset": 10},
        )
        assert result.summary.total_bytes == 0

    def test_get_daily_returns_daily_usage_list(self) -> None:
        usage, mock_http = self._make_usage()
        mock_http.get.return_value = {
            "days": [
                {
                    "date": "2024-06-01",
                    "totalBytes": 500000000,
                    "totalGB": 0.47,
                    "totalCostCents": 235,
                    "totalCostUsd": 2.35,
                    "requestCount": 75,
                },
                {
                    "date": "2024-06-02",
                    "totalBytes": 800000000,
                    "totalGB": 0.74,
                    "totalCostCents": 370,
                    "totalCostUsd": 3.70,
                    "requestCount": 120,
                },
            ],
        }

        result = usage.get_daily()
        assert len(result) == 2
        assert isinstance(result[0], DailyUsage)
        assert result[0].date == "2024-06-01"
        assert result[0].total_gb == 0.47
        assert result[1].request_count == 120

    def test_get_top_hosts_returns_host_list(self) -> None:
        usage, mock_http = self._make_usage()
        mock_http.get.return_value = {
            "hosts": [
                {
                    "targetHost": "api.example.com",
                    "totalBytes": 2000000000,
                    "totalGB": 1.86,
                    "requestCount": 300,
                },
                {
                    "targetHost": "data.example.com",
                    "totalBytes": 500000000,
                    "totalGB": 0.47,
                    "requestCount": 50,
                },
            ],
        }

        result = usage.get_top_hosts(limit=5)
        assert len(result) == 2
        assert isinstance(result[0], TopHost)
        assert result[0].target_host == "api.example.com"
        assert result[0].total_gb == 1.86
        assert result[1].request_count == 50
        mock_http.get.assert_called_once_with(
            "/api/usage/top-hosts",
            params={"limit": 5},
        )

    def test_export_csv_returns_text(self) -> None:
        usage, mock_http = self._make_usage()

        # get_raw returns a mock response with .text attribute
        mock_response = MagicMock()
        mock_response.text = "date,bytes,cost\n2024-06-01,500000000,235\n"
        mock_http.get_raw.return_value = mock_response

        result = usage.export_csv()
        assert "date,bytes,cost" in result
        mock_http.get_raw.assert_called_once_with(
            "/api/usage/export",
            params={},
        )

    def test_export_csv_with_date_range(self) -> None:
        usage, mock_http = self._make_usage()
        mock_response = MagicMock()
        mock_response.text = "date,bytes,cost\n"
        mock_http.get_raw.return_value = mock_response

        usage.export_csv(since="2024-06-01", until="2024-06-30")
        mock_http.get_raw.assert_called_once_with(
            "/api/usage/export",
            params={"since": "2024-06-01", "until": "2024-06-30"},
        )
