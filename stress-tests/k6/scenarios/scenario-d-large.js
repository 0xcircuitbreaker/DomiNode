/**
 * Scenario D: Large Requests (100MB)
 * Purpose: Memory stability and settlement accuracy under heavy bandwidth.
 * Duration: Per-request (shared iterations)
 * VU Levels: 1, 5, 10
 */

import { sleep } from "k6";
import { getThresholds } from "../lib/thresholds.js";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  checkProxyResponse,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

export const options = {
  scenarios: {
    large_1vu: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "10m",
      startTime: "0s",
    },
    large_5vu: {
      executor: "shared-iterations",
      vus: 5,
      iterations: 5,
      maxDuration: "10m",
      startTime: "3m",
    },
    large_10vu: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 10,
      maxDuration: "10m",
      startTime: "6m",
    },
  },
  thresholds: {
    ...getThresholds(MODE),
    // Relax latency thresholds for 100MB downloads
    http_req_duration: ["p(95)<30000", "p(99)<60000"],
    dominusnode_proxy_latency: ["p(95)<30000", "p(99)<60000"],
  },
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/100mb`;

  const res = proxyGet(
    targetUrl,
    user.apiKey,
    {
      responseType: "binary",
      timeout: "120s",
    },
  );

  checkProxyResponse(res, "large");
  sleep(1);
}
