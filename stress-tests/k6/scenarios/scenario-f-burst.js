/**
 * Scenario F: Burst (Simultaneous Connection Storm)
 * Purpose: Test system behavior when many connections arrive simultaneously.
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
    burst: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1s", target: 50 },
        { duration: "15s", target: 50 },
        { duration: "3s", target: 0 },
        { duration: "1s", target: 100 },
        { duration: "15s", target: 100 },
        { duration: "3s", target: 0 },
        { duration: "1s", target: 200 },
        { duration: "15s", target: 200 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    ...getThresholds(MODE),
    http_req_failed: ["rate<0.05"],
    dominusnode_proxy_success_rate: ["rate>0.95"],
  },
};

export default function () {
  const user = getUserForVU(users);
  const targetUrl = `${getTargetBase()}/payload/1kb`;
  const res = proxyGet(targetUrl, user.apiKey, {});
  checkProxyResponse(res, "burst");
  sleep(0.05);
}
