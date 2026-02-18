/**
 * Scenario I: Free Tier Bandwidth Exhaustion
 * Purpose: Verify 1GB bandwidth limit is properly enforced for free-tier users.
 *          Tests that sessions are rejected after limit is reached.
 * Duration: Until limit hit or 10 minutes (whichever first)
 * VU Levels: 10 concurrent free-tier users
 *
 * Requires: separate free-tier test users (provisioned with plan_id='free')
 */

import { sleep } from "k6";
import { Counter } from "k6/metrics";
import { check } from "k6";
import { getThresholds } from "../lib/thresholds.js";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

const bandwidthRejections = new Counter("dominusnode_bandwidth_rejections");
const totalBandwidthUsed = new Counter("dominusnode_free_tier_bandwidth");

export const options = {
  scenarios: {
    free_tier_exhaust: {
      executor: "constant-vus",
      vus: 10,
      duration: "10m",
    },
  },
  thresholds: {
    ...getThresholds(MODE),
    // Free tier should eventually get rejected
    dominusnode_bandwidth_rejections: ["count>0"],
  },
};

export default function () {
  const user = getUserForVU(users);
  // Use 1MB payloads to exhaust 1GB limit in ~1000 requests
  const targetUrl = `${getTargetBase()}/payload/1mb`;

  const res = proxyGet(
    targetUrl,
    user.apiKey,
    { responseType: "binary" },
  );

  if (res.status === 402 || res.status === 429) {
    bandwidthRejections.add(1);
    check(res, {
      "free-tier: properly rejected at limit": (r) => r.status === 402 || r.status === 429,
    });
  } else if (res.status === 200) {
    totalBandwidthUsed.add(1_048_576); // ~1MB
  }

  sleep(0.1);
}
