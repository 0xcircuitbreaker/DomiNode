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
 *   mastra | flowise | openclaw | vercel-ai | openai-functions | n8n | gemini | pi
 *
 * Output JSON:
 *   { balance?, fetch?, usage?, ..., _stats: {ok, err, total}, _categories: {...}, error? }
 *   - Each key is a tool result (stringified)
 *   - _stats: {ok, err, total} — success/failure counts
 *   - _categories: {account, billing, proxy, usage, keys, plans, wallets, teams} — per-category pass/fail
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

// ── Full-lifecycle helper for function-handler integrations ──────────────────
// (OpenAI Functions, Gemini — dispatch by string name)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function extractUuid(text) {
  const m = String(text).match(UUID_RE);
  return m ? m[0] : null;
}

async function lifecycleHandler(handler) {
  const res = {};
  let ok = 0, err = 0;
  const categories = {};

  async function call(key, category, name, args) {
    try {
      const r = await handler(name, args || {});
      res[key] = String(r).slice(0, 500);
      ok++;
      if (!(category in categories)) categories[category] = true;
      return String(r);
    } catch (e) {
      res[key] = `ERROR: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      err++;
      if (!(category in categories)) categories[category] = false;
      return "";
    }
  }

  // Account
  await call("account_info", "account", "dominusnode_get_account_info");
  await call("resend_verify", "account", "dominusnode_resend_verification");
  // Billing
  await call("balance", "billing", "dominusnode_check_balance");
  await call("transactions", "billing", "dominusnode_get_transactions");
  await call("forecast", "billing", "dominusnode_get_forecast");
  await call("topup_paypal", "billing", "dominusnode_topup_paypal", { amount_cents: 100 });
  await call("topup_stripe", "billing", "dominusnode_topup_stripe", { amount_cents: 100 });
  await call("topup_crypto", "billing", "dominusnode_topup_crypto", { amount_usd: 1.0, currency: "BTC" });
  await call("x402_info", "billing", "dominusnode_x402_info");
  // Proxy
  await call("fetch", "proxy", "dominusnode_proxied_fetch", { url: targetUrl, method: "GET", country: "US", proxy_type: proxyType });
  await call("proxy_config", "proxy", "dominusnode_get_proxy_config");
  await call("proxy_status", "proxy", "dominusnode_get_proxy_status");
  await call("sessions", "proxy", "dominusnode_list_sessions");
  // Usage
  await call("usage", "usage", "dominusnode_check_usage", { days: 7 });
  await call("daily_usage", "usage", "dominusnode_get_daily_usage", { days: 7 });
  await call("top_hosts", "usage", "dominusnode_get_top_hosts", { limit: 5 });
  // Keys
  await call("list_keys", "keys", "dominusnode_list_keys");
  const kr = await call("create_key", "keys", "dominusnode_create_key", { label: "showcase-key" });
  const kid = extractUuid(kr);
  if (kid) await call("revoke_key", "keys", "dominusnode_revoke_key", { key_id: kid });
  // Plans
  await call("get_plan", "plans", "dominusnode_get_plan");
  await call("list_plans", "plans", "dominusnode_list_plans");
  // Agentic Wallets
  const wr = await call("create_wallet", "wallets", "dominusnode_create_agentic_wallet", { label: "showcase-wallet", spending_limit_cents: 10000 });
  const wid = extractUuid(wr);
  if (wid) {
    await call("fund_wallet", "wallets", "dominusnode_fund_agentic_wallet", { wallet_id: wid, amount_cents: 100 });
    await call("wallet_balance", "wallets", "dominusnode_agentic_wallet_balance", { wallet_id: wid });
    await call("list_wallets", "wallets", "dominusnode_list_agentic_wallets");
    await call("wallet_txns", "wallets", "dominusnode_agentic_transactions", { wallet_id: wid });
    await call("wallet_policy", "wallets", "dominusnode_update_wallet_policy", { wallet_id: wid, daily_limit_cents: 5000 });
    await call("freeze_wallet", "wallets", "dominusnode_freeze_agentic_wallet", { wallet_id: wid });
    await call("unfreeze_wallet", "wallets", "dominusnode_unfreeze_agentic_wallet", { wallet_id: wid });
    await call("delete_wallet", "wallets", "dominusnode_delete_agentic_wallet", { wallet_id: wid });
  }
  // Teams
  const tr = await call("create_team", "teams", "dominusnode_create_team", { name: "showcase-team" });
  const tid = extractUuid(tr);
  if (tid) {
    await call("list_teams", "teams", "dominusnode_list_teams");
    await call("team_details", "teams", "dominusnode_team_details", { team_id: tid });
    await call("update_team", "teams", "dominusnode_update_team", { team_id: tid, name: "updated-showcase" });
    await call("team_fund", "teams", "dominusnode_team_fund", { team_id: tid, amount_cents: 50 });
    const tkr = await call("team_create_key", "teams", "dominusnode_team_create_key", { team_id: tid, label: "team-key" });
    const tkid = extractUuid(tkr);
    await call("team_list_keys", "teams", "dominusnode_team_list_keys", { team_id: tid });
    await call("team_usage", "teams", "dominusnode_team_usage", { team_id: tid });
    await call("team_members", "teams", "dominusnode_team_list_members", { team_id: tid });
    const ir = await call("team_invite", "teams", "dominusnode_team_invite_member", { team_id: tid, email: "invite-test@dominusnode.bot" });
    const iid = extractUuid(ir);
    await call("team_invites", "teams", "dominusnode_team_list_invites", { team_id: tid });
    if (iid) await call("team_cancel_invite", "teams", "dominusnode_team_cancel_invite", { team_id: tid, invite_id: iid });
    if (tkid) await call("team_revoke_key", "teams", "dominusnode_team_revoke_key", { team_id: tid, key_id: tkid });
    await call("team_delete", "teams", "dominusnode_team_delete", { team_id: tid });
  }

  res._stats = { ok, err, total: ok + err };
  res._categories = categories;
  return res;
}

// ── Full-lifecycle helper for REST-based integrations ────────────────────────
// (n8n, Pi — use auth.apiRequest or raw HTTP)
async function lifecycleRest(authOrFetch) {
  // authOrFetch: { get(path), post(path, body), patch(path, body), del(path), proxyFetch() }
  const res = {};
  let ok = 0, err = 0;
  const categories = {};

  async function call(key, category, fn) {
    try {
      const r = await fn();
      const val = typeof r === "string" ? r : JSON.stringify(r);
      res[key] = val.slice(0, 500);
      ok++;
      if (!(category in categories)) categories[category] = true;
      return val;
    } catch (e) {
      res[key] = `ERROR: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
      err++;
      if (!(category in categories)) categories[category] = false;
      return "";
    }
  }

  const { get, post, patch, del, proxyFetch } = authOrFetch;

  await call("account_info", "account", () => get("/api/auth/me"));
  await call("resend_verify", "account", () => post("/api/auth/resend-verification"));
  await call("balance", "billing", () => get("/api/wallet"));
  await call("transactions", "billing", () => get("/api/wallet/transactions?limit=5"));
  await call("forecast", "billing", () => get("/api/wallet/forecast"));
  await call("topup_paypal", "billing", () => post("/api/billing/paypal/create-order", { amountCents: 100 }));
  await call("topup_stripe", "billing", () => post("/api/billing/stripe/create-session", { amountCents: 100 }));
  await call("topup_crypto", "billing", () => post("/api/billing/crypto/create-invoice", { amountUsd: 1.0, currency: "BTC" }));
  await call("x402_info", "billing", () => get("/api/x402/info"));
  await call("fetch", "proxy", proxyFetch);
  await call("proxy_config", "proxy", () => get("/api/proxy/config"));
  await call("proxy_status", "proxy", () => get("/api/proxy/status"));
  await call("sessions", "proxy", () => get("/api/sessions/active"));
  await call("usage", "usage", () => get("/api/usage"));
  await call("daily_usage", "usage", () => get("/api/usage/daily?days=7"));
  await call("top_hosts", "usage", () => get("/api/usage/top-hosts?limit=5"));
  await call("list_keys", "keys", () => get("/api/keys"));
  const kr = await call("create_key", "keys", () => post("/api/keys", { label: "showcase-key" }));
  const kid = extractUuid(kr);
  if (kid) await call("revoke_key", "keys", () => del(`/api/keys/${kid}`));
  await call("get_plan", "plans", () => get("/api/plans/current"));
  await call("list_plans", "plans", () => get("/api/plans"));
  const wr = await call("create_wallet", "wallets", () => post("/api/agent-wallet", { label: "showcase-wallet", spendingLimitCents: 10000 }));
  const wid = extractUuid(wr);
  if (wid) {
    await call("fund_wallet", "wallets", () => post(`/api/agent-wallet/${wid}/fund`, { amountCents: 100 }));
    await call("wallet_balance", "wallets", () => get(`/api/agent-wallet/${wid}`));
    await call("list_wallets", "wallets", () => get("/api/agent-wallet"));
    await call("wallet_txns", "wallets", () => get(`/api/agent-wallet/${wid}/transactions`));
    await call("wallet_policy", "wallets", () => patch(`/api/agent-wallet/${wid}/policy`, { dailyLimitCents: 5000 }));
    await call("freeze_wallet", "wallets", () => post(`/api/agent-wallet/${wid}/freeze`));
    await call("unfreeze_wallet", "wallets", () => post(`/api/agent-wallet/${wid}/unfreeze`));
    await call("delete_wallet", "wallets", () => del(`/api/agent-wallet/${wid}`));
  }
  const tr = await call("create_team", "teams", () => post("/api/teams", { name: "showcase-team" }));
  const tid = extractUuid(tr);
  if (tid) {
    await call("list_teams", "teams", () => get("/api/teams"));
    await call("team_details", "teams", () => get(`/api/teams/${tid}`));
    await call("update_team", "teams", () => patch(`/api/teams/${tid}`, { name: "updated-showcase" }));
    await call("team_fund", "teams", () => post(`/api/teams/${tid}/fund`, { amountCents: 50 }));
    const tkr = await call("team_create_key", "teams", () => post(`/api/teams/${tid}/keys`, { label: "team-key" }));
    const tkid = extractUuid(tkr);
    await call("team_list_keys", "teams", () => get(`/api/teams/${tid}/keys`));
    await call("team_usage", "teams", () => get(`/api/teams/${tid}/usage`));
    await call("team_members", "teams", () => get(`/api/teams/${tid}/members`));
    const ir = await call("team_invite", "teams", () => post(`/api/teams/${tid}/invites`, { email: "invite-test@dominusnode.bot", role: "member" }));
    const iid = extractUuid(ir);
    await call("team_invites", "teams", () => get(`/api/teams/${tid}/invites`));
    if (iid) await call("team_cancel_invite", "teams", () => del(`/api/teams/${tid}/invites/${iid}`));
    if (tkid) await call("team_revoke_key", "teams", () => del(`/api/teams/${tid}/keys/${tkid}`));
    await call("team_delete", "teams", () => del(`/api/teams/${tid}`));
  }

  res._stats = { ok, err, total: ok + err };
  res._categories = categories;
  return res;
}

// ── Proxy fetch helper (raw HTTP through gateway) ────────────────────────────
function makeProxyFetcher(userAgent) {
  return async () => {
    const http = require("node:http");
    const proxyAuth = "Basic " + Buffer.from(
      `${proxyType}-country-US:${apiKey}`
    ).toString("base64");
    const targetParsed = new URL(targetUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: proxyHost, port: proxyPort, method: "GET", path: targetUrl,
        headers: { Host: targetParsed.host, "Proxy-Authorization": proxyAuth, "User-Agent": userAgent },
      }, (res) => {
        const chunks = []; let bytes = 0;
        res.on("data", (c) => { bytes += c.length; chunks.push(c); });
        res.on("end", () => resolve(JSON.stringify({ status: res.statusCode ?? 0, bytes, body: Buffer.concat(chunks).toString("utf-8").slice(0, 200) })));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(20_000, () => { req.destroy(); reject(new Error("proxy request timed out")); });
      req.end();
    });
  };
}

// ── Runner: OpenAI Functions ──────────────────────────────────────────────────
async function runOpenAIFunctions() {
  const { createDominusNodeFunctionHandler } = require(
    path.join(INTEGRATIONS_DIR, "openai-functions/dist/handler.js")
  );
  const handler = createDominusNodeFunctionHandler({ apiKey, baseUrl: apiBase });
  return lifecycleHandler(handler);
}

// ── Runner: Gemini / Vertex AI ────────────────────────────────────────────────
async function runGemini() {
  const handlerUrl = pathToFileURL(path.join(INTEGRATIONS_DIR, "gemini/dist/handler.js")).href;
  const mod = await import(handlerUrl);
  const createHandler = mod.createDominusNodeFunctionHandler || (mod.default && mod.default.createDominusNodeFunctionHandler);
  if (!createHandler) throw new Error("createDominusNodeFunctionHandler not found in gemini handler");
  const handler = createHandler({ apiKey, baseUrl: apiBase });
  return lifecycleHandler(handler);
}

// ── Runner: OpenClaw ──────────────────────────────────────────────────────────
async function runOpenClaw() {
  process.env.DOMINUSNODE_API_KEY    = apiKey;
  process.env.DOMINUSNODE_BASE_URL   = apiBase;
  process.env.DOMINUSNODE_PROXY_HOST = proxyHost;
  process.env.DOMINUSNODE_PROXY_PORT = String(proxyPort);

  const pluginUrl = pathToFileURL(path.join(INTEGRATIONS_DIR, "openclaw/dist/plugin.js")).href;
  const mod = await import(pluginUrl);
  const tools = mod.tools || (mod.default && mod.default.tools) || [];
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  // Adapt OpenClaw tool.execute({}) into a handler(name, args) interface
  async function handler(name, args) {
    // OpenClaw uses snake_case names without "dominusnode_" prefix
    const shortName = name.replace("dominusnode_", "");
    const tool = byName[shortName] || byName[name];
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool.execute(args || {});
  }
  return lifecycleHandler(handler);
}

// ── Runner: Vercel AI ─────────────────────────────────────────────────────────
async function runVercelAI() {
  const modUrl = pathToFileURL(path.join(INTEGRATIONS_DIR, "vercel-ai/dist/index.js")).href;
  const mod = await import(modUrl);
  const tools = await mod.createDominusNodeTools({ apiKey, baseUrl: apiBase, proxyHost, proxyPort });

  // Map camelCase tool names to dominusnode_snake_case handler calls
  const toolMap = {};
  for (const [k, v] of Object.entries(tools)) {
    if (v && typeof v.execute === "function") {
      toolMap[k] = v;
    }
  }

  // Build a snake_case → camelCase mapping
  function toCamel(s) {
    return s.replace("dominusnode_", "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  async function handler(name, args) {
    const camel = toCamel(name);
    const tool = toolMap[camel] || toolMap[name];
    if (!tool) throw new Error(`tool ${name} (${camel}) not found`);
    return JSON.stringify(await tool.execute(args || {}));
  }
  return lifecycleHandler(handler);
}

// ── Runner: Mastra ────────────────────────────────────────────────────────────
async function runMastra() {
  const { DominusNodeToolkit } = require(path.join(INTEGRATIONS_DIR, "mastra/dist/index.js"));
  const tk = new DominusNodeToolkit({ apiKey, baseUrl: apiBase, proxyHost, proxyPort });

  // Mastra toolkit has methods directly — wrap them as a handler
  function toCamel(s) {
    return s.replace("dominusnode_", "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  async function handler(name, args) {
    const method = toCamel(name);
    if (typeof tk[method] !== "function") throw new Error(`method ${method} not found on Mastra toolkit`);
    const r = await tk[method](...Object.values(args || {}));
    return typeof r === "string" ? r : JSON.stringify(r);
  }
  return lifecycleHandler(handler);
}

// ── Runner: Flowise ───────────────────────────────────────────────────────────
async function runFlowise() {
  const { DominusNodeToolkit } = require(path.join(INTEGRATIONS_DIR, "flowise/dist/index.js"));
  const tk = new DominusNodeToolkit({ apiKey, baseUrl: apiBase, proxyHost, proxyPort });

  function toCamel(s) {
    return s.replace("dominusnode_", "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  async function handler(name, args) {
    const method = toCamel(name);
    if (typeof tk[method] !== "function") throw new Error(`method ${method} not found on Flowise toolkit`);
    const r = await tk[method](...Object.values(args || {}));
    return typeof r === "string" ? r : JSON.stringify(r);
  }
  return lifecycleHandler(handler);
}

// ── Runner: n8n ───────────────────────────────────────────────────────────────
async function runN8n() {
  const { DominusNodeAuth } = require(path.join(INTEGRATIONS_DIR, "n8n/dist/shared/auth.js"));
  const auth = new DominusNodeAuth(apiKey, apiBase);

  return lifecycleRest({
    get:   (p) => auth.apiRequest("GET", p),
    post:  (p, b) => auth.apiRequest("POST", p, b),
    patch: (p, b) => auth.apiRequest("PATCH", p, b),
    del:   (p) => auth.apiRequest("DELETE", p),
    proxyFetch: makeProxyFetcher("n8n-nodes-dominusnode/1.0.0"),
  });
}

// ── Runner: Pi (pi-mono) ──────────────────────────────────────────────────────
async function runPi() {
  const { DominusNodeToolkit } = require(path.join(INTEGRATIONS_DIR, "pi/dist/index.js"));
  const tk = new DominusNodeToolkit({ apiKey, baseUrl: apiBase });

  function extractPiText(val) {
    if (val && val.content && Array.isArray(val.content) && val.content[0]) {
      return String(val.content[0].text || "");
    }
    return typeof val === "string" ? val : JSON.stringify(val);
  }

  // Pi methods return PiToolResult, adapt to handler interface
  function toCamel(s) {
    return s.replace("dominusnode_", "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
  async function handler(name, args) {
    // Proxy fetch goes through raw HTTP (Pi blocks private IPs)
    if (name === "dominusnode_proxied_fetch") {
      return makeProxyFetcher("dominusnode-pi/1.0.0")();
    }
    const method = toCamel(name);
    if (typeof tk[method] !== "function") throw new Error(`method ${method} not found on Pi toolkit`);
    const r = await tk[method](...Object.values(args || {}));
    return extractPiText(r);
  }
  return lifecycleHandler(handler);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
const RUNNERS = {
  "mastra":            runMastra,
  "flowise":           runFlowise,
  "openclaw":          runOpenClaw,
  "vercel-ai":         runVercelAI,
  "openai-functions":  runOpenAIFunctions,
  "n8n":               runN8n,
  "gemini":            runGemini,
  "pi":                runPi,
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

  // Enforce a 120 s hard timeout across the entire lifecycle runner
  const timeout = setTimeout(() => {
    outputError(`Runner timed out after 120s (integration: ${integrationId})`);
  }, 120_000).unref();

  try {
    const result = await runner();
    clearTimeout(timeout);
    outputResult(result);
  } catch (err) {
    clearTimeout(timeout);
    outputError(err instanceof Error ? err.message : String(err));
  }
})();
