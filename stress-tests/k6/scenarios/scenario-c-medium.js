/**
 * Scenario C: Medium Requests (1MB)
 * Purpose: Bandwidth throughput measurement.
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
    medium_requests: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 5 },
        { duration: "20s", target: 5 },
        { duration: "3s", target: 25 },
        { duration: "20s", target: 25 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: getThresholds(MODE),
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/1mb`;
  const res = proxyGet(targetUrl, user.apiKey, { responseType: "binary" });
  checkProxyResponse(res, "medium");
  sleep(0.5);
}
