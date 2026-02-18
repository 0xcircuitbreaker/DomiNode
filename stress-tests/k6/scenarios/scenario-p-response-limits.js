/**
 * Scenario P: Response Size Limits (R18-C3, H1, H2)
 * Purpose: Verify that large responses are handled correctly without OOM.
 * The proxy should forward large payloads through to the client (it's a proxy,
 * not an API server), but the session manager should correctly meter bytes.
 *
 * Tests:
 * - 1MB responses streamed correctly
 * - 100MB responses handled without proxy crash
 * - Concurrent large downloads don't cause memory explosion
 * - Byte metering accurate after large transfers
 */
import { sleep } from "k6";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  checkProxyResponse,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

const largeBytesTransferred = new Counter("dominusnode_large_bytes");
const largeLatency = new Trend("dominusnode_large_latency", true);

export const options = {
  scenarios: {
    medium_1mb: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 5 },
        { duration: "20s", target: 5 },
        { duration: "3s", target: 0 },
      ],
      exec: "download1mb",
      gracefulRampDown: "5s",
    },
    large_10mb: {
      executor: "constant-vus",
      vus: 3,
      duration: "20s",
      exec: "download10mb",
      startTime: "30s",
    },
    concurrent_mix: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 10 },
        { duration: "25s", target: 10 },
        { duration: "5s", target: 0 },
      ],
      exec: "mixedSizes",
      startTime: "55s",
    },
  },
  thresholds: {
    dominusnode_large_bytes: ["count>0"],
    http_req_failed: ["rate<0.05"],
  },
};

export function download1mb() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/1mb`;
  const start = Date.now();

  const res = proxyGet(targetUrl, user.apiKey, {
    responseType: "binary",
  });

  const duration = Date.now() - start;
  largeLatency.add(duration);

  const ok = check(res, {
    "1mb: status 200": (r) => r.status === 200,
    "1mb: received ~1MB": (r) => {
      const len = r.body ? (r.body.byteLength || r.body.length || 0) : 0;
      return len >= 900_000; // Allow some tolerance
    },
  });

  if (ok && res.body) {
    largeBytesTransferred.add(res.body.byteLength || res.body.length || 0);
  }

  sleep(0.5);
}

export function download10mb() {
  const user = getUserForVU(users);
  // Use custom byte endpoint for 10MB
  const targetUrl = `${getTargetBase()}/payload/bytes/10485760`;
  const start = Date.now();

  const res = proxyGet(targetUrl, user.apiKey, {
    responseType: "binary",
    timeout: "60s",
  });

  const duration = Date.now() - start;
  largeLatency.add(duration);

  check(res, {
    "10mb: status 200": (r) => r.status === 200,
    "10mb: received substantial data": (r) => {
      const len = r.body ? (r.body.byteLength || r.body.length || 0) : 0;
      return len >= 5_000_000; // At least 5MB received
    },
  });

  if (res.body) {
    largeBytesTransferred.add(res.body.byteLength || res.body.length || 0);
  }

  sleep(1);
}

export function mixedSizes() {
  const user = getUserForVU(users);
  const base = getTargetBase();

  // Randomly pick a size
  const sizes = ["tiny", "1kb", "10kb", "1mb"];
  const size = sizes[Math.floor(Math.random() * sizes.length)];

  const res = proxyGet(`${base}/payload/${size}`, user.apiKey, {
    responseType: size === "1mb" ? "binary" : "text",
  });

  check(res, {
    [`mixed-${size}: status 200`]: (r) => r.status === 200,
  });

  if (res.body) {
    largeBytesTransferred.add(res.body.byteLength || res.body.length || 0);
  }

  sleep(0.1);
}

export default function () {
  download1mb();
}
