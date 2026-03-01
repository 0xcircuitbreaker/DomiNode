/**
 * Scenario N: SessionId Length Cap (R18-C1)
 * Purpose: Verify that oversized sessionId values in proxy username are properly
 * handled (capped at 255 chars) without crashes or log injection.
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

const oversizedSessionErrors = new Counter("dominusnode_oversized_session_handled");
const crashErrors = new Counter("dominusnode_crash_errors");

export const options = {
  scenarios: {
    sessionid_cap: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
      exec: "oversizedSessionId",
    },
    normal_session: {
      executor: "constant-vus",
      vus: 5,
      duration: "20s",
      exec: "normalSessionId",
      startTime: "25s",
    },
  },
  thresholds: {
    dominusnode_crash_errors: ["count==0"],
  },
};

// Verify oversized sessionId doesn't crash the proxy
export function oversizedSessionId() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/tiny`;

  // Create a proxy username with a 500-char sessionId (should be capped to 255)
  const longSession = "a".repeat(500);
  const username = `dc-session-${longSession}`;

  const res = http.get(targetUrl, {
    headers: {
      "Proxy-Authorization": `Basic ${encoding.b64encode(`${username}:${user.apiKey}`)}`,
    },
  });

  const handled = check(res, {
    "oversized-session: no 5xx crash": (r) => r.status < 500,
    "oversized-session: got response": (r) => r.status > 0,
  });

  if (handled) {
    oversizedSessionErrors.add(1);
  }

  if (res.status >= 500) {
    crashErrors.add(1);
  }

  sleep(0.1);
}

// Verify normal sessionId still works
export function normalSessionId() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const normalSession = "sess12345678";
  const username = `dc-session-${normalSession}`;

  const res = http.get(targetUrl, {
    headers: {
      "Proxy-Authorization": `Basic ${encoding.b64encode(`${username}:${user.apiKey}`)}`,
    },
  });

  check(res, {
    "normal-session: status 200": (r) => r.status === 200,
  });

  sleep(0.1);
}

export default function () {
  oversizedSessionId();
}
