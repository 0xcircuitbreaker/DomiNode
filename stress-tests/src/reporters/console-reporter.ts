export interface ScenarioResult {
  scenario: string;
  vuLevel: number;
  duration: string;
  metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    errorRate: number; // 0-100
    reqPerSec: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    bytesTransferred: number;
    peakActiveSessions: number;
    heapGrowthMb: number;
  };
  thresholds: {
    p95Passed: boolean;
    p99Passed: boolean;
    errorRatePassed: boolean;
    throughputPassed: boolean;
    heapPassed: boolean;
  };
  passed: boolean;
}

export interface SuiteResult {
  mode: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  scenarios: ScenarioResult[];
  overallPassed: boolean;
}

function pad(str: string, width: number, align: "left" | "right" = "left"): string {
  if (str.length >= width) return str.slice(0, width);
  const padding = " ".repeat(width - str.length);
  return align === "right" ? padding + str : str + padding;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)}GB`;
}

function statusIcon(passed: boolean): string {
  return passed ? "PASS" : "FAIL";
}

export function printScenarioResult(result: ScenarioResult): void {
  const m = result.metrics;
  const t = result.thresholds;

  console.log("");
  console.log(`  Scenario: ${result.scenario} | VUs: ${result.vuLevel} | Duration: ${result.duration}`);
  console.log(`  Status: ${statusIcon(result.passed)}`);
  console.log("  " + "-".repeat(70));

  const rows = [
    ["Total Requests", String(m.totalRequests), ""],
    ["Successful", String(m.successfulRequests), ""],
    ["Failed", String(m.failedRequests), ""],
    ["Error Rate", `${m.errorRate.toFixed(2)}%`, statusIcon(t.errorRatePassed)],
    ["Req/sec", m.reqPerSec.toFixed(1), statusIcon(t.throughputPassed)],
    ["p50 Latency", `${m.p50LatencyMs.toFixed(0)}ms`, ""],
    ["p95 Latency", `${m.p95LatencyMs.toFixed(0)}ms`, statusIcon(t.p95Passed)],
    ["p99 Latency", `${m.p99LatencyMs.toFixed(0)}ms`, statusIcon(t.p99Passed)],
    ["Bytes Transferred", formatBytes(m.bytesTransferred), ""],
    ["Peak Sessions", String(m.peakActiveSessions), ""],
    ["Heap Growth", `${m.heapGrowthMb.toFixed(1)}MB`, statusIcon(t.heapPassed)],
  ];

  for (const [label, value, status] of rows) {
    console.log(
      `  ${pad(label, 20)} ${pad(value, 15, "right")}  ${status}`,
    );
  }
}

export function printSuiteSummary(suite: SuiteResult): void {
  console.log("");
  console.log("=".repeat(78));
  console.log("  STRESS TEST SUITE SUMMARY");
  console.log("=".repeat(78));
  console.log(`  Mode:       ${suite.mode}`);
  console.log(`  Started:    ${suite.startedAt}`);
  console.log(`  Completed:  ${suite.completedAt}`);
  console.log(`  Duration:   ${(suite.totalDurationMs / 1000).toFixed(1)}s`);
  console.log("");

  // Summary table
  console.log(
    `  ${pad("Scenario", 18)} ${pad("VUs", 6)} ${pad("Req/s", 10, "right")} ${pad("p95", 10, "right")} ${pad("Err%", 8, "right")} ${pad("Status", 6)}`,
  );
  console.log("  " + "-".repeat(70));

  for (const result of suite.scenarios) {
    console.log(
      `  ${pad(result.scenario, 18)} ${pad(String(result.vuLevel), 6)} ${pad(result.metrics.reqPerSec.toFixed(1), 10, "right")} ${pad(result.metrics.p95LatencyMs.toFixed(0) + "ms", 10, "right")} ${pad(result.metrics.errorRate.toFixed(2) + "%", 8, "right")} ${pad(statusIcon(result.passed), 6)}`,
    );
  }

  console.log("  " + "-".repeat(70));

  const total = suite.scenarios.length;
  const passed = suite.scenarios.filter((s) => s.passed).length;
  const failed = total - passed;

  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log("");
  console.log(`  OVERALL: ${statusIcon(suite.overallPassed)}`);
  console.log("=".repeat(78));
}
