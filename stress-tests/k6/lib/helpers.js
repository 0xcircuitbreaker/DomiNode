import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import http from "k6/http";
import encoding from "k6/encoding";

// Custom metrics
export const bytesTransferred = new Counter("dominusnode_bytes_transferred");
export const proxyErrors = new Counter("dominusnode_proxy_errors");
export const authErrors = new Counter("dominusnode_auth_errors");
export const balanceErrors = new Counter("dominusnode_balance_errors");
export const rateLimitErrors = new Counter("dominusnode_rate_limit_errors");
export const proxySuccessRate = new Rate("dominusnode_proxy_success_rate");
export const proxyLatency = new Trend("dominusnode_proxy_latency", true);

/**
 * Load test user credentials from the provisioned users file.
 * k6's open() resolves relative to the calling script file.
 * Called from k6/scenarios/*.js → ../../results/test-users.json
 */
export function loadTestUsers() {
  const data = open("../../results/test-users.json");
  const parsed = JSON.parse(data);
  return parsed.users;
}

/**
 * Get a test user for the current VU (round-robin).
 */
export function getUserForVU(users) {
  return users[__VU % users.length];
}

/**
 * Build proxy authorization header for Dominus Node proxy.
 */
export function buildProxyAuth(apiKey) {
  return `Basic ${encoding.b64encode(`stress:${apiKey}`)}`;
}

/**
 * Make an HTTP request through the Dominus Node proxy.
 *
 * k6 uses HTTP_PROXY env var to route all requests through the proxy.
 * We add the Proxy-Authorization header for authentication.
 * The target URL uses a public hostname (e.g. httpbin.org) to pass
 * SSRF checks; the mock-upstream intercepts and routes to mock-target.
 */
export function proxyGet(targetUrl, apiKey, params) {
  const start = Date.now();

  const res = http.get(targetUrl, {
    ...params,
    headers: {
      ...((params && params.headers) || {}),
      "Proxy-Authorization": buildProxyAuth(apiKey),
    },
  });

  const duration = Date.now() - start;
  proxyLatency.add(duration);

  const success = res.status >= 200 && res.status < 400;
  proxySuccessRate.add(success);

  if (res.body) {
    bytesTransferred.add(typeof res.body === "string" ? res.body.length : res.body.byteLength || 0);
  }

  if (res.status === 407) {
    authErrors.add(1);
    proxyErrors.add(1);
  } else if (res.status === 402) {
    balanceErrors.add(1);
    proxyErrors.add(1);
  } else if (res.status === 429) {
    rateLimitErrors.add(1);
    proxyErrors.add(1);
  } else if (res.status >= 400) {
    proxyErrors.add(1);
  }

  return res;
}

/**
 * Check standard proxy response.
 */
export function checkProxyResponse(res, scenarioName) {
  check(res, {
    [`${scenarioName}: status is 200`]: (r) => r.status === 200,
    [`${scenarioName}: body not empty`]: (r) => r.body && (r.body.length > 0 || r.body.byteLength > 0),
    [`${scenarioName}: no proxy error header`]: (r) => !r.headers["X-Dominusnode-Error"],
  });
}

// Environment helpers
export function getEnv(name, defaultValue) {
  return __ENV[name] || defaultValue;
}

export function getTargetBase() {
  return getEnv("TARGET_BASE", "http://httpbin.org");
}
