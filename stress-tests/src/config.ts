export type TestMode = "local" | "production";

export interface StressConfig {
  mode: TestMode;

  // Target endpoints
  proxyHost: string;
  proxyHttpPort: number;
  proxySocks5Port: number;
  apiBaseUrl: string;
  targetBaseUrl: string;

  // Database (for provisioning)
  databaseUrl: string;

  // Concurrency levels to test
  vuLevels: number[];

  // Production safety guards
  maxVUs: number;
  maxPayloadBytes: number;
  totalBudgetBytes: number;
  requireConfirmation: boolean;

  // Timing
  defaultDurationPerLevel: string; // k6 duration string e.g. "30s"
  sustainedDuration: string;

  // Thresholds
  thresholds: {
    p95LatencyMs: number;
    p99LatencyMs: number;
    errorRatePercent: number;
    minThroughputReqSec: number;
    maxHeapGrowthMb: number;
  };

  // Internal stats endpoint
  internalStatsUrl: string;
  internalStatsToken: string;
}

const LOCAL_CONFIG: StressConfig = {
  mode: "local",
  proxyHost: "localhost",
  proxyHttpPort: parseInt(process.env.STRESS_PROXY_PORT ?? "8088", 10),
  proxySocks5Port: parseInt(process.env.STRESS_SOCKS5_PORT ?? "1088", 10),
  apiBaseUrl: process.env.STRESS_API_URL ?? "http://localhost:3000",
  targetBaseUrl: process.env.STRESS_TARGET_URL ?? "http://httpbin.org",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://dominusnode:dominusnode_dev@localhost:5432/dominusnode",
  vuLevels: [1, 5, 10, 25, 50, 100, 500, 1000],
  maxVUs: 1000,
  maxPayloadBytes: 1_073_741_824, // 1GB
  totalBudgetBytes: Number.MAX_SAFE_INTEGER,
  requireConfirmation: false,
  defaultDurationPerLevel: "30s",
  sustainedDuration: "5m",
  thresholds: {
    p95LatencyMs: 500,
    p99LatencyMs: 2000,
    errorRatePercent: 1,
    minThroughputReqSec: 500,
    maxHeapGrowthMb: 100,
  },
  internalStatsUrl: `http://localhost:${process.env.STRESS_PROXY_PORT ?? "8088"}/internal/stats`,
  internalStatsToken: process.env.JWT_SECRET ?? "test-secret",
};

const PRODUCTION_CONFIG: StressConfig = {
  mode: "production",
  proxyHost: "proxy.dominusnode.com",
  proxyHttpPort: 8080,
  proxySocks5Port: 1080,
  apiBaseUrl: "https://api.dominusnode.com",
  targetBaseUrl: "https://httpbin.org",
  databaseUrl: process.env.DATABASE_URL ?? "",
  vuLevels: [1, 5, 10],
  maxVUs: 10,
  maxPayloadBytes: 10_485_760, // 10MB
  totalBudgetBytes: 5_368_709_120, // 5GB
  requireConfirmation: true,
  defaultDurationPerLevel: "30s",
  sustainedDuration: "2m",
  thresholds: {
    p95LatencyMs: 2000,
    p99LatencyMs: 5000,
    errorRatePercent: 1,
    minThroughputReqSec: 50,
    maxHeapGrowthMb: 100,
  },
  internalStatsUrl: "https://api.dominusnode.com/internal/stats",
  internalStatsToken: process.env.JWT_SECRET ?? "",
};

export function getConfig(mode?: TestMode): StressConfig {
  const m = mode ?? (process.env.STRESS_MODE as TestMode) ?? "local";
  return m === "production" ? PRODUCTION_CONFIG : LOCAL_CONFIG;
}

export const PAYLOAD_SIZES: Record<string, number> = {
  tiny: 10,
  "1kb": 1_024,
  "10kb": 10_240,
  "1mb": 1_048_576,
  "100mb": 104_857_600,
  "1gb": 1_073_741_824,
};

export const SCENARIOS = [
  "a-tiny",
  "b-small",
  "c-medium",
  "d-large",
  "e-sustained",
  "f-burst",
  "g-churn",
  "h-mixed",
  "i-free-tier",
  "j-errors",
  "k-single-500mb",
  "l-multi-100mb",
  "m-sustained-1mb",
  "n-sessionid-cap",
  "o-redirect-safety",
  "p-response-limits",
  "q-rate-limits",
] as const;

export type ScenarioId = (typeof SCENARIOS)[number];
