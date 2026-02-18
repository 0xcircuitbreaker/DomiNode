/**
 * Scenario A: Tiny Requests (10 bytes)
 * Purpose: Measure pure proxy overhead/latency with minimal payload.
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
    tiny_requests: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 5 },
        { duration: "20s", target: 5 },
        { duration: "3s", target: 25 },
        { duration: "20s", target: 25 },
        { duration: "3s", target: 100 },
        { duration: "20s", target: 100 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: getThresholds(MODE),
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/tiny`;
  const res = proxyGet(targetUrl, user.apiKey, {});
  checkProxyResponse(res, "tiny");
  sleep(0.1);
}
