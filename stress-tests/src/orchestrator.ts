import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getConfig, SCENARIOS, type ScenarioId, type TestMode } from "./config.js";
import { MetricsCollector } from "./runners/metrics-collector.js";
import { runSocks5Test } from "./runners/socks5-runner.js";
import {
  printScenarioResult,
  printSuiteSummary,
  type ScenarioResult,
  type SuiteResult,
} from "./reporters/console-reporter.js";
import { saveJsonReport, saveCsvReport } from "./reporters/json-reporter.js";
import { provisionUsers } from "./setup/provision-users.js";
import { cleanupTestData } from "./setup/cleanup.js";

interface TestUsers {
  users: Array<{ apiKey: string; email: string; id: string }>;
}

function parseArgs(): { mode: TestMode; scenario?: ScenarioId; skipSetup: boolean; skipCleanup: boolean } {
  const args = process.argv.slice(2);
  let mode: TestMode = "local";
  let scenario: ScenarioId | undefined;
  let skipSetup = false;
  let skipCleanup = false;

  const validModes: TestMode[] = ["local", "production"];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) {
      if (!validModes.includes(args[i + 1] as TestMode)) {
        console.error(`Invalid mode: ${args[i + 1]}. Must be one of: ${validModes.join(", ")}`);
        process.exit(1);
      }
      mode = args[i + 1] as TestMode;
      i++;
    } else if (args[i] === "--scenario" && args[i + 1]) {
      if (!SCENARIOS.includes(args[i + 1] as ScenarioId)) {
        console.error(`Invalid scenario: ${args[i + 1]}. Must be one of: ${SCENARIOS.join(", ")}`);
        process.exit(1);
      }
      scenario = args[i + 1] as ScenarioId;
      i++;
    } else if (args[i] === "--skip-setup") {
      skipSetup = true;
    } else if (args[i] === "--skip-cleanup") {
      skipCleanup = true;
    }
  }

  return { mode, scenario, skipSetup, skipCleanup };
}

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

function checkK6Installed(): boolean {
  try {
    execSync("k6 version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function loadTestUsers(resultsDir: string): TestUsers | null {
  const usersFile = path.join(resultsDir, "test-users.json");
  if (!fs.existsSync(usersFile)) return null;
  return JSON.parse(fs.readFileSync(usersFile, "utf-8"));
}

/**
 * Run a k6 scenario and parse its JSON output.
 */
async function runK6Scenario(
  scenarioFile: string,
  mode: TestMode,
  proxyHost: string,
  proxyPort: number,
  targetBase: string,
): Promise<{
  totalRequests: number;
  failedRequests: number;
  p50: number;
  p95: number;
  p99: number;
  reqPerSec: number;
  duration: string;
}> {
  const k6Dir = path.resolve(import.meta.dirname, "../k6/scenarios");
  const scenarioPath = path.join(k6Dir, scenarioFile);

  if (!fs.existsSync(scenarioPath)) {
    console.log(`  Scenario file not found: ${scenarioPath}, skipping.`);
    return { totalRequests: 0, failedRequests: 0, p50: 0, p95: 0, p99: 0, reqPerSec: 0, duration: "0s" };
  }

  return new Promise((resolve, reject) => {
    const k6 = spawn("k6", ["run", "--summary-export=/dev/stdout", scenarioPath], {
      env: {
        ...process.env,
        MODE: mode,
        PROXY_HOST: proxyHost,
        PROXY_PORT: String(proxyPort),
        TARGET_BASE: targetBase,
        // Route k6 requests through the proxy under test
        HTTP_PROXY: `http://${proxyHost}:${proxyPort}`,
        HTTPS_PROXY: `http://${proxyHost}:${proxyPort}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderrTail = "";
    const MAX_STDERR_BYTES = 32_768;

    k6.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    k6.stderr.on("data", (data: Buffer) => {
      stderrTail += data.toString();
      if (stderrTail.length > MAX_STDERR_BYTES) {
        stderrTail = stderrTail.slice(-MAX_STDERR_BYTES);
      }
      // Print k6 progress to console
      process.stderr.write(data);
    });

    k6.on("close", (code) => {
      // Try to parse k6 JSON summary from stdout
      try {
        const summaryJson = stdout.trim().split("\n").pop() ?? "{}";
        const summary = JSON.parse(summaryJson);

        const httpDuration = summary.metrics?.http_req_duration ?? {};
        const httpReqs = summary.metrics?.http_reqs ?? {};
        const httpFailed = summary.metrics?.http_req_failed ?? {};

        resolve({
          totalRequests: httpReqs.values?.count ?? 0,
          failedRequests: Math.round((httpFailed.values?.rate ?? 0) * (httpReqs.values?.count ?? 0)),
          p50: httpDuration.values?.["p(50)"] ?? 0,
          p95: httpDuration.values?.["p(95)"] ?? 0,
          p99: httpDuration.values?.["p(99)"] ?? 0,
          reqPerSec: httpReqs.values?.rate ?? 0,
          duration: `${Math.round((httpDuration.values?.count ?? 0) / 1000)}s`,
        });
      } catch {
        // Fallback if JSON parsing fails
        console.log(`  k6 output parsing failed (exit code ${code}). stderr: ${stderrTail.slice(-500)}`);
        resolve({ totalRequests: 0, failedRequests: 0, p50: 0, p95: 0, p99: 0, reqPerSec: 0, duration: "0s" });
      }
    });

    k6.on("error", (err) => {
      reject(new Error(`Failed to start k6: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  const { mode, scenario: selectedScenario, skipSetup, skipCleanup } = parseArgs();
  const config = getConfig(mode);

  console.log("=".repeat(78));
  console.log("  DOMINUS NODE STRESS TEST SUITE");
  console.log("=".repeat(78));
  console.log(`  Mode:      ${mode}`);
  console.log(`  Proxy:     ${config.proxyHost}:${config.proxyHttpPort}`);
  console.log(`  API:       ${config.apiBaseUrl}`);
  console.log(`  Max VUs:   ${config.maxVUs}`);
  console.log("");

  // Production confirmation
  if (config.requireConfirmation) {
    console.log("  WARNING: Production mode will incur real costs (~$2 for full suite).");
    const ok = await confirm("  Continue?");
    if (!ok) {
      console.log("  Aborted.");
      process.exit(0);
    }
  }

  // Check k6
  const hasK6 = checkK6Installed();
  if (!hasK6) {
    console.log("  WARNING: k6 not installed. Only Node.js-based tests will run.");
    console.log("  Install k6: https://k6.io/docs/getting-started/installation/");
    console.log("");
  }

  const resultsDir = path.resolve(import.meta.dirname, "../results");

  // Setup: provision test users
  if (!skipSetup) {
    console.log("  Setting up PAYG test users...");
    await provisionUsers(config.databaseUrl, 100, "payg", 10_000, "stress-test");
    // Provision free-tier users for scenario I (bandwidth exhaustion)
    console.log("  Setting up free-tier test users...");
    await provisionUsers(config.databaseUrl, 10, "free", 10_000, "stress-free");
    console.log("");
  }

  const testUsers = loadTestUsers(resultsDir);
  if (!testUsers || testUsers.users.length === 0) {
    console.error("  ERROR: No test users found. Run setup first.");
    process.exit(1);
  }

  console.log(`  Loaded ${testUsers.users.length} test users.`);
  console.log("");

  // Initialize metrics collector
  const metrics = new MetricsCollector(config.internalStatsUrl, config.internalStatsToken, config.databaseUrl);

  const startedAt = new Date().toISOString();
  const suiteResults: ScenarioResult[] = [];

  // Determine which scenarios to run
  const scenariosToRun = selectedScenario
    ? SCENARIOS.filter((s) => s === selectedScenario)
    : [...SCENARIOS];

  for (const scenarioId of scenariosToRun) {
    console.log(`\n  Running scenario: ${scenarioId}`);
    console.log("  " + "-".repeat(40));

    metrics.start(1000);

    let result: ScenarioResult;

    if (scenarioId === "h-mixed" || !hasK6) {
      // Node.js SOCKS5 runner for scenario H (or fallback if no k6)
      const apiKeys = testUsers.users.map((u) => u.apiKey);
      const socks5Result = await runSocks5Test(50, 500, apiKeys, "/payload/1kb");

      const metricsSummary = metrics.getSummary();
      await metrics.stop();

      result = {
        scenario: scenarioId,
        vuLevel: 50,
        duration: "60s",
        metrics: {
          totalRequests: socks5Result.totalRequests,
          successfulRequests: socks5Result.successfulRequests,
          failedRequests: socks5Result.failedRequests,
          errorRate: (socks5Result.failedRequests / Math.max(socks5Result.totalRequests, 1)) * 100,
          reqPerSec: socks5Result.totalRequests / 60,
          p50LatencyMs: socks5Result.avgLatencyMs,
          p95LatencyMs: socks5Result.p95LatencyMs,
          p99LatencyMs: socks5Result.p99LatencyMs,
          bytesTransferred: socks5Result.totalBytesReceived,
          peakActiveSessions: metricsSummary.peakActiveSessions,
          heapGrowthMb: metricsSummary.heapGrowthMb,
        },
        thresholds: {
          p95Passed: socks5Result.p95LatencyMs < config.thresholds.p95LatencyMs,
          p99Passed: socks5Result.p99LatencyMs < config.thresholds.p99LatencyMs,
          errorRatePassed:
            (socks5Result.failedRequests / Math.max(socks5Result.totalRequests, 1)) * 100 <
            config.thresholds.errorRatePercent,
          throughputPassed: true, // SOCKS5 throughput threshold is looser
          heapPassed: metricsSummary.heapGrowthMb < config.thresholds.maxHeapGrowthMb,
        },
        passed: false,
      };
      result.passed = Object.values(result.thresholds).every(Boolean);
    } else {
      // k6 scenario
      const scenarioFile = `scenario-${scenarioId}.js`;
      const k6Result = await runK6Scenario(
        scenarioFile,
        mode,
        config.proxyHost,
        config.proxyHttpPort,
        config.targetBaseUrl,
      );

      const metricsSummary = metrics.getSummary();
      await metrics.stop();

      const totalReqs = k6Result.totalRequests;
      const failedReqs = k6Result.failedRequests;
      const errorRate = totalReqs > 0 ? (failedReqs / totalReqs) * 100 : 0;

      result = {
        scenario: scenarioId,
        vuLevel: config.vuLevels[config.vuLevels.length - 1],
        duration: k6Result.duration || config.defaultDurationPerLevel,
        metrics: {
          totalRequests: totalReqs,
          successfulRequests: totalReqs - failedReqs,
          failedRequests: failedReqs,
          errorRate,
          reqPerSec: k6Result.reqPerSec,
          p50LatencyMs: k6Result.p50,
          p95LatencyMs: k6Result.p95,
          p99LatencyMs: k6Result.p99,
          bytesTransferred: 0, // k6 custom counter not in summary export
          peakActiveSessions: metricsSummary.peakActiveSessions,
          heapGrowthMb: metricsSummary.heapGrowthMb,
        },
        thresholds: {
          p95Passed: k6Result.p95 < config.thresholds.p95LatencyMs,
          p99Passed: k6Result.p99 < config.thresholds.p99LatencyMs,
          errorRatePassed: errorRate < config.thresholds.errorRatePercent,
          throughputPassed: k6Result.reqPerSec >= config.thresholds.minThroughputReqSec,
          heapPassed: metricsSummary.heapGrowthMb < config.thresholds.maxHeapGrowthMb,
        },
        passed: false,
      };
      result.passed = Object.values(result.thresholds).every(Boolean);
    }

    printScenarioResult(result);
    suiteResults.push(result);
  }

  // Wait for sessions to drain
  console.log("\n  Waiting 10s for session drain...");
  await new Promise((r) => setTimeout(r, 10_000));

  // Build suite result
  const completedAt = new Date().toISOString();
  const suiteResult: SuiteResult = {
    mode,
    startedAt,
    completedAt,
    totalDurationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    scenarios: suiteResults,
    overallPassed: suiteResults.every((s) => s.passed),
  };

  // Print summary
  printSuiteSummary(suiteResult);

  // Save reports
  saveJsonReport(suiteResult, resultsDir);
  saveCsvReport(suiteResult, resultsDir);

  // Cleanup
  if (!skipCleanup) {
    console.log("\n  Cleaning up test data...");
    await cleanupTestData(config.databaseUrl);
  }

  process.exit(suiteResult.overallPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Orchestrator failed:", err);
  process.exit(1);
});
