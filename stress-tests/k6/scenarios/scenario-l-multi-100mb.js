/**
 * Scenario L: 5 × 100MB Requests per User (1,000 VUs)
 * Purpose: Realistic large file download pattern. Tests sustained
 *          throughput per connection across multiple sequential downloads.
 *
 * Total bandwidth: 1,000 × 5 × 100MB = 500GB
 * Estimated duration: ~30-40 min
 */
import { sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  checkProxyResponse,
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
    multi_100mb: {
      executor: "per-vu-iterations",
      vus: 1000,
      iterations: 5,
      maxDuration: "60m",
    },
  },
  thresholds: {
    dominusnode_completed_downloads: ["count>=4500"], // 90% of 5000
    http_req_failed: ["rate<0.10"],
    http_req_duration: ["p(95)<60000", "p(99)<120000"], // 1-2 min for 100MB
  },
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/100mb`;

  const start = Date.now();
  const res = proxyGet(targetUrl, user.apiKey, {
    responseType: "binary",
    timeout: "180s",
  });
  const elapsed = Date.now() - start;

  downloadDuration.add(elapsed);

  if (res.status === 200) {
    completedDownloads.add(1);
    const bodySize = res.body ? (res.body.byteLength || res.body.length || 0) : 0;
    const mbps = bodySize > 0 ? (bodySize / 1024 / 1024) / (elapsed / 1000) : 0;
    if (__VU <= 3 && __ITER === 0) {
      console.log(`VU${__VU}: 100MB #${__ITER+1} in ${(elapsed/1000).toFixed(1)}s (${mbps.toFixed(1)} MB/s)`);
    }
  }

  // Brief pause between downloads
  sleep(0.5);
}
