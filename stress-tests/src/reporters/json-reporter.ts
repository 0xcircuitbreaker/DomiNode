import fs from "node:fs";
import path from "node:path";
import type { SuiteResult } from "./console-reporter.js";

export function saveJsonReport(suite: SuiteResult, outputDir?: string): string {
  const dir = outputDir ?? path.resolve(import.meta.dirname, "../../results");
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `stress-${suite.mode}-${timestamp}.json`;
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, JSON.stringify(suite, null, 2));
  console.log(`JSON report saved to ${filepath}`);
  return filepath;
}

export function saveCsvReport(suite: SuiteResult, outputDir?: string): string {
  const dir = outputDir ?? path.resolve(import.meta.dirname, "../../results");
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `stress-${suite.mode}-${timestamp}.csv`;
  const filepath = path.join(dir, filename);

  const headers = [
    "scenario",
    "vu_level",
    "duration",
    "total_requests",
    "successful_requests",
    "failed_requests",
    "error_rate_pct",
    "req_per_sec",
    "p50_latency_ms",
    "p95_latency_ms",
    "p99_latency_ms",
    "bytes_transferred",
    "peak_sessions",
    "heap_growth_mb",
    "passed",
  ];

  const rows = suite.scenarios.map((s) => [
    s.scenario,
    s.vuLevel,
    s.duration,
    s.metrics.totalRequests,
    s.metrics.successfulRequests,
    s.metrics.failedRequests,
    s.metrics.errorRate.toFixed(2),
    s.metrics.reqPerSec.toFixed(1),
    s.metrics.p50LatencyMs.toFixed(0),
    s.metrics.p95LatencyMs.toFixed(0),
    s.metrics.p99LatencyMs.toFixed(0),
    s.metrics.bytesTransferred,
    s.metrics.peakActiveSessions,
    s.metrics.heapGrowthMb.toFixed(1),
    s.passed ? "PASS" : "FAIL",
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  fs.writeFileSync(filepath, csv);
  console.log(`CSV report saved to ${filepath}`);
  return filepath;
}
