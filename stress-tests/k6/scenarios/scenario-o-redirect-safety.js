/**
 * Scenario O: Redirect Safety (R18-C2, C4)
 * Purpose: Verify that the proxy correctly handles redirect responses
 * without following them (which would leak credentials).
 *
 * Tests that:
 * - Proxy does not follow 301/302 redirects from target
 * - Client receives the redirect status as-is
 * - No credential leakage via redirect following
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

const redirectsHandled = new Counter("dominusnode_redirects_handled");

export const options = {
  scenarios: {
    redirect_301: {
      executor: "constant-vus",
      vus: 5,
      duration: "15s",
      exec: "testRedirect301",
    },
    redirect_302: {
      executor: "constant-vus",
      vus: 5,
      duration: "15s",
      exec: "testRedirect302",
      startTime: "20s",
    },
    normal_after_redirect: {
      executor: "constant-vus",
      vus: 5,
      duration: "15s",
      exec: "normalRequest",
      startTime: "40s",
    },
  },
  thresholds: {
    dominusnode_redirects_handled: ["count>0"],
  },
};

export function testRedirect301() {
  const user = getUserForVU(users);
  // Mock target's /status/301 returns a 301 response
  const targetUrl = `${getTargetBase()}/status/301`;
  const res = proxyGet(targetUrl, user.apiKey, {
    redirects: 0, // Tell k6 not to follow redirects
  });

  const ok = check(res, {
    "redirect-301: returns 301 (not followed)": (r) => r.status === 301,
  });

  if (ok) {
    redirectsHandled.add(1);
  }

  sleep(0.2);
}

export function testRedirect302() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/status/302`;
  const res = proxyGet(targetUrl, user.apiKey, {
    redirects: 0,
  });

  const ok = check(res, {
    "redirect-302: returns 302 (not followed)": (r) => r.status === 302,
  });

  if (ok) {
    redirectsHandled.add(1);
  }

  sleep(0.2);
}

export function normalRequest() {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const res = proxyGet(targetUrl, user.apiKey, {});

  check(res, {
    "normal-after-redirect: status 200": (r) => r.status === 200,
  });

  sleep(0.2);
}

export default function () {
  testRedirect301();
}
