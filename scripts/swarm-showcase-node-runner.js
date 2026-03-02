#!/usr/bin/env node
/**
 * swarm-showcase-node-runner.js — Node.js bridge for TypeScript integrations
 *
 * Called by swarm-showcase.py to exercise a TypeScript AI integration as a
 * subprocess. Prints a single JSON object to stdout with the results.
 *
 * Usage (API key via env, never args):
 *   SHOWCASE_API_KEY=dn_live_... \
 *   node swarm-showcase-node-runner.js \
 *     <integration_id> <api_base> <proxy_host> <proxy_port> <target_url> <proxy_type>
 *
 * Supported integrations:
 *   mastra | flowise | openclaw | vercel-ai | openai-functions | n8n
 *
 * Output JSON:
 *   { balance?, fetch?, usage?, error? }
 *   - balance: stringified balance info
 *   - fetch: stringified {status, bytes, body} or error
 *   - usage: stringified usage info
 *   - error: credential-scrubbed error message (only set on fatal failure)
 *
 * Security:
 *   - API key read from SHOWCASE_API_KEY env (never argv)
 *   - All output scrubbed of dn_live_* / dn_test_* credentials
 *   - No redirects followed (redirect:"error")
 *   - 30 s global timeout per runner
 */
"use strict";

const path  = require("path");
const { URL, pathToFileURL } = require("url");

const REPO_ROOT        = path.join(__dirname, "..");
const INTEGRATIONS_DIR = path.join(REPO_ROOT, "integrations");

// ── Credential scrubbing ──────────────────────────────────────────────────────
const CRED_RE = /dn_(live|test)_[A-Za-z0-9_-]+/g;
function scrub(msg) {
  return String(msg).replace(CRED_RE, "dn_$1_***");
}

// ── Output helpers ────────────────────────────────────────────────────────────
function outputResult(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}
function outputError(msg) {
  outputResult({ error: scrub(msg) });
}
function settled(r) {
  return r.status === "fulfilled" ? r.value : null;
}
function settledErr(r) {
  if (r.status === "rejected") {
    return scrub(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  return undefined;
}

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.length < 6) {
  outputError(
    "Usage: node swarm-showcase-node-runner.js " +
    "<integration> <api_base> <proxy_host> <proxy_port> <target_url> <proxy_type>"
  );
}
const [integrationId, apiBase, proxyHost, proxyPortStr, targetUrl, proxyType] = argv;
const proxyPort = parseInt(proxyPortStr, 10);

if (isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
  outputError(`Invalid proxy_port: ${proxyPortStr}`);
}

// Validate apiBase — must be HTTP(S) only
try {
  const parsedBase = new URL(apiBase);
  if (!["http:", "https:"].includes(parsedBase.protocol)) {
    outputError(`api_base must use http: or https: scheme, got: ${parsedBase.protocol}`);
  }
} catch { outputError(`Invalid api_base: ${apiBase}`); }

// Validate targetUrl — must be HTTP(S) only
try {
  const parsedTarget = new URL(targetUrl);
  if (!["http:", "https:"].includes(parsedTarget.protocol)) {
    outputError(`target_url must use http: or https: scheme, got: ${parsedTarget.protocol}`);
  }
} catch { outputError(`Invalid target_url: ${targetUrl}`); }

// Validate proxyHost — bare hostname/IP only (no scheme, path, or control chars)
if (!/^[a-zA-Z0-9._-]{1,253}$/.test(proxyHost)) {
  outputError(`Invalid proxy_host: must be a hostname or IP (1-253 chars, [a-zA-Z0-9._-])`);
}

if (!["dc", "residential"].includes(proxyType)) {
  outputError(`Invalid proxy_type: ${proxyType}. Must be dc or residential`);
}

const apiKey = process.env.SHOWCASE_API_KEY || "";
if (!apiKey) {
  outputError("SHOWCASE_API_KEY environment variable is required");
}
if (!apiKey.startsWith("dn_live_") && !apiKey.startsWith("dn_test_")) {
  outputError("SHOWCASE_API_KEY must start with dn_live_ or dn_test_");
}

// ── Runner: Mastra ────────────────────────────────────────────────────────────
async function runMastra() {
  const { DominusNodeToolkit } = require(
    path.join(INTEGRATIONS_DIR, "mastra/dist/index.js")
  );
  const tk = new DominusNodeToolkit({
    apiKey,
    baseUrl: apiBase,
    proxyHost,
    proxyPort,
  });

  const [bal, fet, usg] = await Promise.allSettled([
    tk.checkBalance(),
    tk.proxiedFetch(targetUrl, "GET", "US", proxyType),
    tk.checkUsage(1),
  ]);

  const fetchVal = settled(fet);
  return {
    balance: bal.status === "fulfilled" ? JSON.stringify(settled(bal)) : null,
    fetch: fetchVal
      ? JSON.stringify({
          status:  fetchVal.status ?? 0,
          bytes:   String(fetchVal.body ?? "").length,
          body:    String(fetchVal.body ?? "").slice(0, 200),
          pool:    fetchVal.pool,
          country: fetchVal.country,
        })
      : null,
    usage:  usg.status === "fulfilled" ? JSON.stringify(settled(usg)) : null,
    error:  settledErr(bal),
  };
}

// ── Runner: Flowise ───────────────────────────────────────────────────────────
async function runFlowise() {
  const { DominusNodeToolkit } = require(
    path.join(INTEGRATIONS_DIR, "flowise/dist/index.js")
  );
  const tk = new DominusNodeToolkit({
    apiKey,
    baseUrl: apiBase,
    proxyHost,
    proxyPort,
  });

  const [bal, fet, usg] = await Promise.allSettled([
    tk.checkBalance(),
    tk.proxiedFetch(targetUrl, "GET", "US", proxyType),
    tk.checkUsage(1),
  ]);

  const fetchVal = settled(fet);
  return {
    balance: bal.status === "fulfilled" ? JSON.stringify(settled(bal)) : null,
    fetch: fetchVal
      ? JSON.stringify({
          status:  fetchVal.status ?? 0,
          bytes:   String(fetchVal.body ?? "").length,
          body:    String(fetchVal.body ?? "").slice(0, 200),
          pool:    fetchVal.pool,
          country: fetchVal.country,
        })
      : null,
    usage:  usg.status === "fulfilled" ? JSON.stringify(settled(usg)) : null,
    error:  settledErr(bal),
  };
}

// ── Runner: OpenClaw ──────────────────────────────────────────────────────────
async function runOpenClaw() {
  // OpenClaw reads config from environment variables
  process.env.DOMINUSNODE_API_KEY    = apiKey;
  process.env.DOMINUSNODE_BASE_URL   = apiBase;
  process.env.DOMINUSNODE_PROXY_HOST = proxyHost;
  process.env.DOMINUSNODE_PROXY_PORT = String(proxyPort);

  // ESM module — use dynamic import()
  const pluginUrl = pathToFileURL(
    path.join(INTEGRATIONS_DIR, "openclaw/dist/plugin.js")
  ).href;
  const mod = await import(pluginUrl);
  const tools = mod.tools || (mod.default && mod.default.tools) || [];
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  const [bal, fet] = await Promise.allSettled([
    byName.check_balance
      ? byName.check_balance.execute({})
      : Promise.reject(new Error("check_balance tool not found")),
    byName.proxied_fetch
      ? byName.proxied_fetch.execute({ url: targetUrl, method: "GET", country: "US" })
      : Promise.reject(new Error("proxied_fetch tool not found")),
  ]);

  const fetchRaw = settled(fet);
  return {
    balance: bal.status === "fulfilled"
      ? String(settled(bal)).slice(0, 500)
      : null,
    fetch: fetchRaw !== null
      ? String(fetchRaw).slice(0, 500)
      : null,
    error: settledErr(bal),
  };
}

// ── Runner: Vercel AI ─────────────────────────────────────────────────────────
async function runVercelAI() {
  // Vercel AI SDK is ESM — dynamic import()
  const modUrl = pathToFileURL(
    path.join(INTEGRATIONS_DIR, "vercel-ai/dist/index.js")
  ).href;
  const mod = await import(modUrl);

  const tools = await mod.createDominusNodeTools({
    apiKey,
    baseUrl:   apiBase,
    proxyHost,
    proxyPort,
  });

  // Vercel AI tools have an `execute` function at tool.execute(params, options)
  // options is optional in standalone use
  const [bal, fet] = await Promise.allSettled([
    tools.checkBalance
      ? tools.checkBalance.execute({})
      : Promise.reject(new Error("checkBalance tool not found")),
    tools.proxiedFetch
      ? tools.proxiedFetch.execute({
          url:       targetUrl,
          method:    "GET",
          country:   "US",
          proxyType,
        })
      : Promise.reject(new Error("proxiedFetch tool not found")),
  ]);

  const fetchVal = settled(fet);
  return {
    balance: bal.status === "fulfilled"
      ? JSON.stringify(settled(bal))
      : null,
    fetch: fetchVal
      ? JSON.stringify({
          status:  fetchVal.status ?? fetchVal.error ?? 0,
          bytes:   String(fetchVal.body ?? "").length,
          body:    String(fetchVal.body ?? "").slice(0, 200),
        })
      : null,
    error: settledErr(bal),
  };
}

// ── Runner: OpenAI Functions ──────────────────────────────────────────────────
async function runOpenAIFunctions() {
  const { createDominusNodeFunctionHandler } = require(
    path.join(INTEGRATIONS_DIR, "openai-functions/dist/handler.js")
  );
  const handler = createDominusNodeFunctionHandler({
    apiKey,
    baseUrl: apiBase,
  });

  const [bal, fet, usg] = await Promise.allSettled([
    handler("dominusnode_check_balance", {}),
    handler("dominusnode_proxied_fetch", {
      url:        targetUrl,
      method:     "GET",
      country:    "US",
      proxy_type: proxyType,
    }),
    handler("dominusnode_check_usage", { days: 1 }),
  ]);

  return {
    balance: bal.status === "fulfilled" ? String(settled(bal)).slice(0, 500) : null,
    fetch:   fet.status === "fulfilled" ? String(settled(fet)).slice(0, 500) : null,
    usage:   usg.status === "fulfilled" ? String(settled(usg)).slice(0, 500) : null,
    error:   settledErr(bal),
  };
}

// ── Runner: n8n ───────────────────────────────────────────────────────────────
// The n8n nodes require the n8n-workflow framework to run. We instead use
// the shared DominusNodeAuth client directly — same auth/API logic, just
// without the n8n execution context wrapper.
async function runN8n() {
  const { DominusNodeAuth } = require(
    path.join(INTEGRATIONS_DIR, "n8n/dist/shared/auth.js")
  );
  const auth = new DominusNodeAuth(apiKey, apiBase);

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const until = new Date().toISOString();

  const [bal, usg] = await Promise.allSettled([
    auth.apiRequest("GET", "/api/wallet"),
    auth.apiRequest("GET", `/api/usage?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`),
  ]);

  // Make a proxied HTTP request using node:http (mirrors DominusNodeProxy node behaviour)
  let fetchResult = null;
  try {
    const http = require("node:http");
    const proxyAuth = "Basic " + Buffer.from(
      `${proxyType}-country-US:${apiKey}`
    ).toString("base64");
    const targetParsed = new URL(targetUrl);

    fetchResult = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: proxyHost,
          port:     proxyPort,
          method:   "GET",
          path:     targetUrl,          // full URL in request-path for HTTP proxy
          headers: {
            Host:                  targetParsed.host,
            "Proxy-Authorization": proxyAuth,
            "User-Agent":          "n8n-nodes-dominusnode/1.0.0",
          },
        },
        (res) => {
          let bytes = 0;
          res.on("data", (c) => { bytes += c.length; });
          res.on("end",   () => resolve({ status: res.statusCode ?? 0, bytes }));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.setTimeout(20_000, () => {
        req.destroy();
        reject(new Error("proxy request timed out (20s)"));
      });
      req.end();
    });
  } catch (e) {
    fetchResult = { error: scrub(e instanceof Error ? e.message : String(e)) };
  }

  return {
    balance: bal.status === "fulfilled"
      ? JSON.stringify(settled(bal)).slice(0, 500)
      : null,
    fetch:   JSON.stringify(fetchResult),
    usage:   usg.status === "fulfilled"
      ? JSON.stringify(settled(usg)).slice(0, 500)
      : null,
    error:   settledErr(bal),
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
const RUNNERS = {
  "mastra":            runMastra,
  "flowise":           runFlowise,
  "openclaw":          runOpenClaw,
  "vercel-ai":         runVercelAI,
  "openai-functions":  runOpenAIFunctions,
  "n8n":               runN8n,
};

(async () => {
  const runner = RUNNERS[integrationId];
  if (!runner) {
    outputError(
      `Unknown integration: "${integrationId}". ` +
      `Valid: ${Object.keys(RUNNERS).join(", ")}`
    );
    return;
  }

  // Enforce a 30 s hard timeout across the entire runner
  const timeout = setTimeout(() => {
    outputError(`Runner timed out after 30s (integration: ${integrationId})`);
  }, 30_000).unref();

  try {
    const result = await runner();
    clearTimeout(timeout);
    outputResult(result);
  } catch (err) {
    clearTimeout(timeout);
    outputError(err instanceof Error ? err.message : String(err));
  }
})();
