import { getActiveSessionCount } from "./session-manager.js";

const startedAt = Date.now();
let totalRequests = 0;
let totalErrors = 0;
let totalBytesIn = 0;
let totalBytesOut = 0;
let totalSessions = 0;

// Rolling window for latency (last 100 measurements)
const LATENCY_WINDOW = 100;
const latencies: number[] = [];

export function recordRequest(): void {
  totalRequests++;
}

export function recordError(): void {
  totalErrors++;
}

// Larger window for the hourly public status snapshot (p50/p95), bounded.
const PCT_WINDOW = 2000;
const pctSamples: number[] = [];

export function recordLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > LATENCY_WINDOW) {
    latencies.shift();
  }
  if (Number.isFinite(ms) && ms >= 0) {
    pctSamples.push(ms);
    if (pctSamples.length > PCT_WINDOW) pctSamples.shift();
  }
}

/** Nearest-rank percentiles of recent relay connect latency (null with no samples). */
export function getLatencyPercentiles(): { p50: number | null; p95: number | null; samples: number } {
  if (pctSamples.length === 0) return { p50: null, p95: null, samples: 0 };
  const s = [...pctSamples].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]);
  return { p50: at(0.5), p95: at(0.95), samples: s.length };
}

export function getAvgLatencyMs(): number {
  if (latencies.length === 0) return 0;
  const sum = latencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencies.length);
}

export function recordBytes(bytesIn: number, bytesOut: number): void {
  totalBytesIn += bytesIn;
  totalBytesOut += bytesOut;
}

export function recordSessionStart(): void {
  totalSessions++;
}

export interface ProxyStats {
  status: "operational" | "degraded";
  activeSessions: number;
  totalRequests: number;
  totalErrors: number;
  totalBytesIn: number;
  totalBytesOut: number;
  totalSessions: number;
  avgLatencyMs: number;
  uptimeSeconds: number;
}

export function getStats(): ProxyStats {
  const activeSessions = getActiveSessionCount();

  let status: "operational" | "degraded";
  if (totalRequests > 0 && totalErrors / totalRequests > 0.5) {
    status = "degraded";
  } else {
    status = "operational";
  }

  return {
    status,
    activeSessions,
    totalRequests,
    totalErrors,
    totalBytesIn,
    totalBytesOut,
    totalSessions,
    avgLatencyMs: getAvgLatencyMs(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
}

/** Format stats as Prometheus exposition text */
export function getPrometheusMetrics(): string {
  const stats = getStats();
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;

  return [
    "# HELP dominusnode_proxy_requests_total Total proxy requests handled",
    "# TYPE dominusnode_proxy_requests_total counter",
    `dominusnode_proxy_requests_total ${stats.totalRequests}`,
    "",
    "# HELP dominusnode_proxy_errors_total Total proxy errors",
    "# TYPE dominusnode_proxy_errors_total counter",
    `dominusnode_proxy_errors_total ${stats.totalErrors}`,
    "",
    "# HELP dominusnode_proxy_sessions_total Total sessions created",
    "# TYPE dominusnode_proxy_sessions_total counter",
    `dominusnode_proxy_sessions_total ${stats.totalSessions}`,
    "",
    "# HELP dominusnode_proxy_active_sessions Current active sessions",
    "# TYPE dominusnode_proxy_active_sessions gauge",
    `dominusnode_proxy_active_sessions ${stats.activeSessions}`,
    "",
    "# HELP dominusnode_proxy_bytes_in_total Total bytes received from clients",
    "# TYPE dominusnode_proxy_bytes_in_total counter",
    `dominusnode_proxy_bytes_in_total ${stats.totalBytesIn}`,
    "",
    "# HELP dominusnode_proxy_bytes_out_total Total bytes sent to clients",
    "# TYPE dominusnode_proxy_bytes_out_total counter",
    `dominusnode_proxy_bytes_out_total ${stats.totalBytesOut}`,
    "",
    "# HELP dominusnode_proxy_latency_ms Proxy connect latency percentiles",
    "# TYPE dominusnode_proxy_latency_ms gauge",
    `dominusnode_proxy_latency_ms{quantile="0.5"} ${p50}`,
    `dominusnode_proxy_latency_ms{quantile="0.95"} ${p95}`,
    `dominusnode_proxy_latency_ms{quantile="0.99"} ${p99}`,
    "",
    "# HELP dominusnode_proxy_uptime_seconds Proxy uptime in seconds",
    "# TYPE dominusnode_proxy_uptime_seconds gauge",
    `dominusnode_proxy_uptime_seconds ${stats.uptimeSeconds}`,
    "",
    `# HELP dominusnode_proxy_status Proxy status (1=operational, 0=degraded)`,
    `# TYPE dominusnode_proxy_status gauge`,
    `dominusnode_proxy_status ${stats.status === "operational" ? 1 : 0}`,
    "",
  ].join("\n");
}

/** Reset for testing */
export function _reset(): void {
  totalRequests = 0;
  totalErrors = 0;
  totalBytesIn = 0;
  totalBytesOut = 0;
  totalSessions = 0;
  latencies.length = 0;
  pctSamples.length = 0;
}
