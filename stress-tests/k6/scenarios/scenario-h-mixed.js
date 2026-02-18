/**
 * Scenario H: Mixed Protocol (HTTP + SOCKS5)
 * Purpose: Validate HTTP and SOCKS5 can handle simultaneous load.
 * Duration: 60s
 * VU Levels: 50 HTTP + 50 SOCKS5
 *
 * Note: k6 doesn't natively support SOCKS5. The HTTP portion runs here;
 * SOCKS5 testing is handled by the Node.js socks5-runner.ts.
 * The orchestrator runs both in parallel.
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

const PAYLOADS = ["/payload/tiny", "/payload/1kb", "/payload/10kb", "/payload/1mb"];

export const options = {
  scenarios: {
    http_mixed: {
      executor: "constant-vus",
      vus: 50,
      duration: "60s",
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

  checkProxyResponse(res, "mixed-http");
  sleep(0.2);
}
