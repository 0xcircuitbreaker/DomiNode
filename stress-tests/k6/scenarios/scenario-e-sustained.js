/**
 * Scenario E: Sustained 5-minute Load
 * Purpose: Detect memory leaks, connection pool exhaustion, session cleanup issues.
 * Duration: 5 minutes at each VU level
 * VU Levels: 25, 50, 100
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

const PAYLOADS = ["/payload/tiny", "/payload/1kb", "/payload/10kb"];

export const options = {
  scenarios: {
    sustained_25: {
      executor: "constant-vus",
      vus: 25,
      duration: "5m",
      startTime: "0s",
    },
    sustained_50: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      startTime: "5m30s",
    },
    sustained_100: {
      executor: "constant-vus",
      vus: 100,
      duration: "5m",
      startTime: "11m",
    },
  },
  thresholds: getThresholds(MODE),
};

export default function () {
  const user = getUserForVU(users);
  const payload = PAYLOADS[Math.floor(Math.random() * PAYLOADS.length)];
  const targetUrl = `${getTargetBase()}${payload}`;

  const res = proxyGet(
    targetUrl,
    user.apiKey,
    {},
  );

  checkProxyResponse(res, "sustained");
  sleep(0.3);
}
