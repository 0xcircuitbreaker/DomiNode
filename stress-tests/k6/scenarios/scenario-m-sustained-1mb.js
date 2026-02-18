/**
 * Scenario M: 500 × 1MB Requests per User (1,000 VUs)
 * Purpose: Realistic web proxy traffic pattern. Tests connection churn,
 *          session management, and billing accuracy at scale.
 *
 * Total bandwidth: 1,000 × 500 × 1MB = 500GB
 * Estimated duration: ~5-6 hours
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
const completedDownloads = new Counter("dominusnode_completed_downloads");

export const options = {
  scenarios: {
    sustained_1mb: {
      executor: "per-vu-iterations",
      vus: 1000,
      iterations: 500,
      maxDuration: "8h",
    },
  },
  thresholds: {
    dominusnode_completed_downloads: ["count>=450000"], // 90% of 500,000
    http_req_failed: ["rate<0.01"],                      // Stricter: <1% for small payloads
    http_req_duration: ["p(95)<2000", "p(99)<5000"],     // 2-5s for 1MB
    dominusnode_proxy_success_rate: ["rate>0.99"],
    dominusnode_proxy_latency: ["p(95)<2000", "p(99)<5000"],
  },
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/1mb`;

  const res = proxyGet(targetUrl, user.apiKey, {
    responseType: "binary",
    timeout: "30s",
  });

  if (res.status === 200) {
    completedDownloads.add(1);
  }

  checkProxyResponse(res, "sustained");

  // Small pause to simulate real traffic pattern
  if (Math.random() < 0.3) {
    sleep(0.1);
  }
}
