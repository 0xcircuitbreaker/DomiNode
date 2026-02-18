/**
 * Scenario Q: Rate Limit Validation (R18-H7)
 * Purpose: Verify that rate limiting works correctly under load:
 * - Per-user session rate limits (MAX_SESSIONS_PER_MINUTE)
 * - Proxy returns 429 for excess sessions
 * - System recovers after rate limit window expires
 */
import { sleep } from "k6";
import { check } from "k6";
import { Counter } from "k6/metrics";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

const rateLimitHits = new Counter("dominusnode_rate_limit_hits");
const successAfterLimit = new Counter("dominusnode_success_after_limit");

export const options = {
  scenarios: {
    normal_load: {
      executor: "constant-vus",
      vus: 20,
      duration: "20s",
      exec: "normalLoad",
    },
    burst_single_user: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 200,
      exec: "burstSingleUser",
      startTime: "25s",
      maxDuration: "30s",
    },
    recovery: {
      executor: "constant-vus",
      vus: 5,
      duration: "15s",
      exec: "normalLoad",
      startTime: "60s",
    },
  },
  thresholds: {
    // We expect some rate limit hits in burst mode
    dominusnode_rate_limit_hits: ["count>0"],
    // But normal load should mostly succeed
    dominusnode_success_after_limit: ["count>0"],
  },
};

export function normalLoad() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const res = proxyGet(targetUrl, user.apiKey, {});

  check(res, {
    "normal-load: status 200 or 429": (r) => r.status === 200 || r.status === 429,
  });

  if (res.status === 429) {
    rateLimitHits.add(1);
  }
  if (res.status === 200) {
    successAfterLimit.add(1);
  }

  sleep(0.1);
}

// Deliberately hammer with single user to trigger per-user rate limit
export function burstSingleUser() {
  // Always use first user to concentrate load
  const user = users[0];
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const res = proxyGet(targetUrl, user.apiKey, {});

  if (res.status === 429) {
    rateLimitHits.add(1);
  }

  check(res, {
    "burst: got expected response (200 or 429)": (r) => r.status === 200 || r.status === 429,
    "burst: no server errors": (r) => r.status < 500,
  });

  // No sleep — intentional burst
}

export default function () {
  normalLoad();
}
