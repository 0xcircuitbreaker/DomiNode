import { getActiveSessionCount } from "./session-manager.js";

const startedAt = Date.now();
let totalRequests = 0;
let totalErrors = 0;

// Rolling window for latency (last 100 measurements)
const LATENCY_WINDOW = 100;
const latencies: number[] = [];

export function recordRequest(): void {
  totalRequests++;
}

export function recordError(): void {
  totalErrors++;
}

export function recordLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > LATENCY_WINDOW) {
    latencies.shift();
  }
}

export function getAvgLatencyMs(): number {
  if (latencies.length === 0) return 0;
  const sum = latencies.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencies.length);
}

export interface ProxyStats {
  status: "operational" | "degraded";
  activeSessions: number;
  totalRequests: number;
  totalErrors: number;
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
    avgLatencyMs: getAvgLatencyMs(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  };
}

/** Reset for testing */
export function _reset(): void {
  totalRequests = 0;
  totalErrors = 0;
  latencies.length = 0;
}
