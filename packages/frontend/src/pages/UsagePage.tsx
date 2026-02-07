import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get } from "../api/client";
import UsageChart from "../components/UsageChart";
import TopHosts from "../components/TopHosts";
import CsvExportButton from "../components/CsvExportButton";

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

  const { data, loading, refetch } = useApi<UsageResponse>(
    () => get(`/api/usage?since=${since}T00:00:00Z&until=${until}T23:59:59Z&limit=${pageSize}&offset=${page * pageSize}`),
  );

  const { data: daily } = useApi<DailyResponse>(
    () => get(`/api/usage/daily?since=${since}T00:00:00Z&until=${until}T23:59:59Z`),
  );

  const totalPages = data ? Math.ceil(data.pagination.total / pageSize) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Usage</h1>

      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Total Data</p>
          <p className="text-3xl font-bold mt-1">
            {data?.summary.totalGB.toFixed(3) ?? "0.000"} GB
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Total Cost</p>
          <p className="text-3xl font-bold mt-1">
            ${data?.summary.totalCostUsd.toFixed(2) ?? "0.00"}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-sm text-gray-400">Requests</p>
          <p className="text-3xl font-bold mt-1">
            {data?.summary.requestCount ?? 0}
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Daily Breakdown</h2>
          <div className="flex gap-1">
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
      <div className="flex items-center gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>
        <button
          onClick={() => { setPage(0); refetch(); }}
          className="mt-5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
        >
          Apply
        </button>
        <div className="mt-5">
          <CsvExportButton since={since} until={until} />
        </div>
      </div>

      {/* Top Hosts */}
      <TopHosts since={since} until={until} />

      {/* Records Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-gray-400">
              <th className="text-left px-4 py-3 font-medium">Target</th>
              <th className="text-left px-4 py-3 font-medium">Upload</th>
              <th className="text-left px-4 py-3 font-medium">Download</th>
              <th className="text-left px-4 py-3 font-medium">Total</th>
              <th className="text-left px-4 py-3 font-medium">Cost</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : !data?.records.length ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                  No usage records for this period.
                </td>
              </tr>
            ) : (
              data.records.map((r) => (
                <tr key={r.id} className="border-b border-gray-800/50">
                  <td className="px-4 py-3 font-mono text-xs">{r.targetHost}</td>
                  <td className="px-4 py-3 text-gray-400">{formatBytes(r.bytesIn)}</td>
                  <td className="px-4 py-3 text-gray-400">{formatBytes(r.bytesOut)}</td>
                  <td className="px-4 py-3">{formatBytes(r.totalBytes)}</td>
                  <td className="px-4 py-3 text-red-400">${(r.costCents / 100).toFixed(4)}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              Page {page + 1} of {totalPages} ({data?.pagination.total} records)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => { setPage(Math.max(0, page - 1)); refetch(); }}
                disabled={page === 0}
                className="px-3 py-1 rounded text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => { setPage(Math.min(totalPages - 1, page + 1)); refetch(); }}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded text-xs bg-gray-800 text-gray-400 hover:bg-gray-700 disabled:opacity-50"
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
