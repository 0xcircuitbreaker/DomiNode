import { useEffect, useCallback, useRef, useState } from "react";
import { get } from "../api/client";
import ResponsiveTable from "./ResponsiveTable";

interface ActiveSession {
  id: string;
  startedAt: string;
  proxyIp: string;
  status: string;
}

interface ActiveSessionsResponse {
  sessions: ActiveSession[];
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

export default function ActiveSessions() {
  const [data, setData] = useState<ActiveSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      const result = await get<ActiveSessionsResponse>("/api/sessions/active");
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    intervalRef.current = setInterval(fetchSessions, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSessions]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Active Sessions</h2>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-xs text-gray-500">Live</span>
        </div>
      </div>

      {loading && !data ? (
        <p className="text-sm text-gray-500 py-4 text-center">Loading...</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-4 text-center">{error}</p>
      ) : !data?.sessions.length ? (
        <p className="text-sm text-gray-500 py-4 text-center">No active sessions</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800">
          <ResponsiveTable<ActiveSession>
            columns={[
              { key: "id", header: "Session ID", primary: true, render: (s) => <span className="font-mono text-xs text-gray-300">{s.id.slice(0, 8)}...</span> },
              { key: "started", header: "Started", render: (s) => <span className="text-gray-400 text-xs">{timeAgo(s.startedAt)}</span> },
              { key: "status", header: "Status", render: (s) => (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/30 text-green-400 border border-green-800/50">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                  {s.status}
                </span>
              )},
            ]}
            data={data.sessions}
            keyExtractor={(s) => s.id}
          />
        </div>
      )}

      <p className="text-xs text-gray-600 mt-3">
        Auto-refreshes every 10 seconds
      </p>
    </div>
  );
}
