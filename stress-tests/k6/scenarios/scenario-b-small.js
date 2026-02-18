/**
 * Scenario B: Small Requests (1KB-10KB)
 * Purpose: Throughput with realistic web page proxy payloads.
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
const PAYLOADS = ["/payload/1kb", "/payload/10kb"];

export const options = {
  scenarios: {
    small_requests: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 5 },
        { duration: "20s", target: 5 },
        { duration: "3s", target: 25 },
        { duration: "20s", target: 25 },
        { duration: "3s", target: 50 },
        { duration: "20s", target: 50 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: getThresholds(MODE),
};

export default function () {
  const user = getUserForVU(users);
  const payload = PAYLOADS[Math.floor(Math.random() * PAYLOADS.length)];
  const targetUrl = `${getTargetBase()}${payload}`;
  const res = proxyGet(targetUrl, user.apiKey, {});
  checkProxyResponse(res, "small");
  sleep(0.2);
}
