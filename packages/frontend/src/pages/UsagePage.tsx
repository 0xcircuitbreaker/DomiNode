import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";
import UsageChart from "../components/UsageChart";
import TopHosts from "../components/TopHosts";
import CsvExportButton from "../components/CsvExportButton";
import ResponsiveTable from "../components/ResponsiveTable";

interface UsageRecord {
  id: string;
  sessionId: string;
  bytesIn: number;
  bytesOut: number;
  totalBytes: number;
  costCents: number;
  proxyType: string;
  targetHost: string;
  createdAt: string;
}

interface UsageResponse {
  summary: {
    totalBytes: number;
    totalCostCents: number;
    requestCount: number;
    totalGB: number;
    totalCostUsd: number;
  };
  records: UsageRecord[];
  pagination: { limit: number; offset: number; total: number };
  period: { since: string; until: string };
}

interface DailyDay {
  date: string;
  totalGB: number;
  totalCostUsd: number;
  requestCount: number;
}

interface DailyResponse {
  days: DailyDay[];
}

type ChartMetric = "bandwidth" | "cost" | "requests";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(3)} GB`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

export default function UsagePage() {
  const [since, setSince] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [until, setUntil] = useState(() => new Date().toISOString().split("T")[0]);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("bandwidth");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Validate date params before sending to API
  const safeSince = isValidDate(since) ? since : new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const safeUntil = isValidDate(until) ? until : new Date().toISOString().split("T")[0];

  const { data, loading, refetch } = useApi<UsageResponse>(
    () => get(`/api/usage?since=${safeSince}T00:00:00Z&until=${safeUntil}T23:59:59Z&limit=${pageSize}&offset=${page * pageSize}`),
    [safeSince, safeUntil, page],
  );

  const { data: daily } = useApi<DailyResponse>(
    () => get(`/api/usage/daily?since=${safeSince}T00:00:00Z&until=${safeUntil}T23:59:59Z`),
    [safeSince, safeUntil],
  );

  const totalPages = data ? Math.ceil(data.pagination.total / pageSize) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Usage</h1>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Total Data</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            {data?.summary.totalGB.toFixed(3) ?? "0.000"} GB
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Total Cost</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            ${data?.summary.totalCostUsd.toFixed(2) ?? "0.00"}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5">
          <p className="text-sm text-gray-400">Requests</p>
          <p className="text-xl sm:text-2xl lg:text-3xl font-bold mt-1">
            {data?.summary.requestCount ?? 0}
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="font-semibold">Daily Breakdown</h2>
          <div className="flex flex-wrap gap-1">
            {(["bandwidth", "cost", "requests"] as ChartMetric[]).map((m) => (
              <button
                key={m}
                onClick={() => setChartMetric(m)}
                className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                  chartMetric === m
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <UsageChart days={daily?.days ?? []} metric={chartMetric} />
      </div>

      {/* Date Range */}
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-end gap-3">
        <div className="flex-1 sm:flex-none">
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-full sm:w-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div className="flex-1 sm:flex-none">
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="w-full sm:w-auto bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>
        <button
          onClick={() => { setPage(0); refetch(); }}
          className="sm:mt-5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
        >
          Apply
        </button>
        <div className="sm:mt-5">
          <CsvExportButton since={since} until={until} />
        </div>
      </div>

      {/* Top Hosts — R27 H-5: pass validated dates, not raw input */}
      <TopHosts since={safeSince} until={safeUntil} />

      {/* Records Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <p className="px-4 py-8 text-center text-gray-500 text-sm">Loading...</p>
        ) : (
          <ResponsiveTable<UsageRecord>
            columns={[
              { key: "target", header: "Target", primary: true, render: (r) => <span className="font-mono text-xs">{r.targetHost}</span> },
              { key: "upload", header: "Upload", hideOnMobile: true, render: (r) => <span className="text-gray-400">{formatBytes(r.bytesIn)}</span> },
              { key: "download", header: "Download", hideOnMobile: true, render: (r) => <span className="text-gray-400">{formatBytes(r.bytesOut)}</span> },
              { key: "total", header: "Total", render: (r) => formatBytes(r.totalBytes) },
              { key: "cost", header: "Cost", render: (r) => <span className="text-red-400">${(r.costCents / 100).toFixed(4)}</span> },
              { key: "date", header: "Date", render: (r) => <span className="text-gray-400">{new Date(r.createdAt).toLocaleDateString()}</span> },
            ]}
            data={data?.records ?? []}
            keyExtractor={(r) => r.id}
            emptyMessage="No usage records for this period."
          />
        )}
        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              Page {page + 1} of {totalPages} ({data?.pagination.total} records)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => { setPage(Math.max(0, page - 1)); refetch(); }}
                disabled={page === 0}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => { setPage(Math.min(totalPages - 1, page + 1)); refetch(); }}
                disabled={page >= totalPages - 1}
                className="px-4 py-2 rounded-lg text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
