/**
 * Scenario G: Session Churn
 * Purpose: Rapid connect/disconnect correctness.
 */
import { sleep } from "k6";
import { Counter } from "k6/metrics";
import { getThresholds } from "../lib/thresholds.js";
import {
  loadTestUsers,
  getUserForVU,
  proxyGet,
  getTargetBase,
} from "../lib/helpers.js";

const MODE = __ENV.MODE || "local";
const users = loadTestUsers();

const sessionsOpened = new Counter("dominusnode_sessions_opened");
const sessionsClosed = new Counter("dominusnode_sessions_closed");

export const options = {
  scenarios: {
    churn: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "3s", target: 10 },
        { duration: "20s", target: 10 },
        { duration: "3s", target: 50 },
        { duration: "20s", target: 50 },
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
  sessionsOpened.add(1);
  const res = proxyGet(`${getTargetBase()}/payload/tiny`, user.apiKey, {});
  sessionsClosed.add(1);
  // Minimal delay for maximum churn
  if (Math.random() < 0.1) {
    sleep(0.01);
  }
}
