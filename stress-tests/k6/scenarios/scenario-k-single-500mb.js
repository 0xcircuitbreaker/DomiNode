/**
 * Scenario K: Single 500MB Request per User (1,000 VUs)
 * Purpose: Maximum per-connection stress. Tests proxy memory handling
 *          and streaming under extreme payload sizes.
 *
 * Total bandwidth: 1,000 × 500MB = 500GB
 * Estimated duration: ~15-20 min
 */
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  bytesTransferred,
  proxySuccessRate,
  proxyErrors,
  rateLimitErrors,
  getTargetBase,
} from "../lib/helpers.js";

const users = loadTestUsers();
const downloadDuration = new Trend("dominusnode_download_duration", true);
const completedDownloads = new Counter("dominusnode_completed_downloads");

export const options = {
  scenarios: {
    single_500mb: {
      executor: "per-vu-iterations",
      vus: 1000,
      iterations: 1,
      maxDuration: "30m",
    },
  },
  thresholds: {
    dominusnode_completed_downloads: ["count>=900"],   // At least 90% complete
    http_req_failed: ["rate<0.10"],                     // Allow up to 10% for extreme load
    http_req_duration: ["p(95)<120000", "p(99)<180000"], // 2-3 min for 500MB is fine
  },
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/bytes/524288000`; // 500MB

  const start = Date.now();
  const res = proxyGet(targetUrl, user.apiKey, {
    responseType: "binary",
    timeout: "300s", // 5 min timeout for 500MB
  });
  const elapsed = Date.now() - start;

  downloadDuration.add(elapsed);

  if (res.status === 200) {
    completedDownloads.add(1);
    const bodySize = res.body ? (res.body.byteLength || res.body.length || 0) : 0;
    // Calculate throughput
    const mbps = bodySize > 0 ? (bodySize / 1024 / 1024) / (elapsed / 1000) : 0;
    if (__VU <= 5) {
      console.log(`VU${__VU}: 500MB downloaded in ${(elapsed/1000).toFixed(1)}s (${mbps.toFixed(1)} MB/s)`);
    }
  } else {
    if (__VU <= 5) {
      console.log(`VU${__VU}: FAILED status=${res.status}`);
    }
  }
}
