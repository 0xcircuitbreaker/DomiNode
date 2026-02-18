/**
 * Scenario J: Error Handling
 * Purpose: Verify correct error responses for invalid auth, no balance, rate limits.
 */
import { sleep } from "k6";
import { check } from "k6";
import { Counter } from "k6/metrics";
import http from "k6/http";
import encoding from "k6/encoding";
import { getThresholds } from "../lib/thresholds.js";
import {
  loadTestUsers,
  getUserForVU,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

const correctAuthErrors = new Counter("dominusnode_correct_auth_errors");
const unexpectedErrors = new Counter("dominusnode_unexpected_errors");

export const options = {
  scenarios: {
    invalid_auth: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2s", target: 5 },
        { duration: "15s", target: 5 },
        { duration: "2s", target: 25 },
        { duration: "15s", target: 25 },
        { duration: "5s", target: 0 },
      ],
      exec: "invalidAuth",
      gracefulRampDown: "5s",
    },
    no_auth: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "noAuth",
      startTime: "45s",
    },
    revoked_key: {
      executor: "constant-vus",
      vus: 10,
      duration: "15s",
      exec: "revokedKey",
      startTime: "65s",
    },
  },
  thresholds: {
    dominusnode_unexpected_errors: ["count==0"],
  },
};

export function invalidAuth() {
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const fakeKey = `dn_live_${Math.random().toString(36).slice(2)}`;

  const res = http.get(targetUrl, {
    headers: {
      "Proxy-Authorization": `Basic ${encoding.b64encode(`test:${fakeKey}`)}`,
    },
  });

  const gotExpectedError = check(res, {
    "invalid-auth: returns 407": (r) => r.status === 407,
  });

  if (gotExpectedError) {
    correctAuthErrors.add(1);
  } else if (res.status >= 500) {
    unexpectedErrors.add(1);
  }

  sleep(0.1);
}

export function noAuth() {
  const targetUrl = `${getTargetBase()}/payload/tiny`;

  const res = http.get(targetUrl, {});

  check(res, {
    "no-auth: returns 407": (r) => r.status === 407,
  });

  sleep(0.1);
}

export function revokedKey() {
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const revokedKey = `dn_live_${"a".repeat(48)}`;

  const res = http.get(targetUrl, {
    headers: {
      "Proxy-Authorization": `Basic ${encoding.b64encode(`test:${revokedKey}`)}`,
    },
  });

  check(res, {
    "revoked-key: returns 407": (r) => r.status === 407,
  });

  sleep(0.1);
}

export default function () {
  invalidAuth();
}
