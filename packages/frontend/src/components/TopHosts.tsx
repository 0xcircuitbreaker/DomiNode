import { useApi } from "../hooks/useApi";
import { get } from "../api/client";

interface HostEntry {
  targetHost: string;
  totalBytes: number;
  totalGB: number;
  requestCount: number;
}

interface TopHostsResponse {
  hosts: HostEntry[];
  period: { since: string; until: string };
}

interface TopHostsProps {
  since: string;
  until: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(3)} GB`;
}

export default function TopHosts({ since, until }: TopHostsProps) {
  const { data, loading } = useApi<TopHostsResponse>(
    () => get(`/api/usage/top-hosts?since=${since}T00:00:00Z&until=${until}T23:59:59Z&limit=10`),
    [since, until],
  );

  // Filter out empty host entries (from sessions where target host logging was disabled)
  const hosts = (data?.hosts ?? []).filter((h) => h.targetHost && h.targetHost.length > 0);

  const maxBytes = hosts.length
    ? Math.max(...hosts.map((h) => h.totalBytes))
    : 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="font-semibold mb-4">Top Target Hosts</h2>

      {loading ? (
        <p className="text-sm text-gray-500 py-4 text-center">Loading...</p>
      ) : !hosts.length ? (
        <p className="text-sm text-gray-500 py-4 text-center">
          No host data for this period.
        </p>
      ) : (
        <div className="space-y-3">
          {hosts.map((host) => {
            const pct = maxBytes > 0 ? (host.totalBytes / maxBytes) * 100 : 0;

            return (
              <div key={host.targetHost}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-xs text-gray-300 truncate max-w-[60%]">
                    {host.targetHost || "(empty)"}
                  </span>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span>{formatBytes(host.totalBytes)}</span>
                    <span className="text-gray-600">|</span>
                    <span>{host.requestCount.toLocaleString()} req</span>
                  </div>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(pct, 1)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
