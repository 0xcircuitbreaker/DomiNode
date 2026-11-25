/**
 * Scoped, revocable dn_proxy_ tokens (docs/agent-network/AGENT_API.md
 * "Proxy tokens"). A proxy token goes in the proxy password field instead of
 * the dn_live_ key: it expires, can carry byte and spend caps, and can be
 * revoked without touching the account key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpConfig } from "../config.js";
import { scrubCredentials, type HttpClient } from "../http-client.js";
import { SlidingWindow, perServer } from "../session-limiter.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_RE = /^[1-9][0-9]{0,15}$/;
const TOKEN_RE = /^dn_proxy_[A-Za-z0-9_-]{43}$/;

const limiter = perServer(() => new SlidingWindow(10, 60_000));

interface ProxyTokenView {
  id: string;
  label: string;
  status: string;
  expiresAt: string;
  maxBytes: string | null;
  maxSpendMusd: string | null;
  bytesUsed: string;
  spendUsedMusd: string;
  revokedAt: string | null;
  createdAt: string;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
function errorResult(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${scrubCredentials(err instanceof Error ? err.message : String(err))}` }] };
}
function rateLimited() {
  return { isError: true, content: [{ type: "text" as const, text: "Rate limit exceeded: maximum 10 proxy token operations per minute." }] };
}

function describeToken(t: ProxyTokenView): string {
  const caps = [
    t.maxBytes ? `bytes ${t.bytesUsed}/${t.maxBytes}` : `bytes ${t.bytesUsed} (no cap)`,
    t.maxSpendMusd ? `spend ${t.spendUsedMusd}/${t.maxSpendMusd} µUSD` : `spend ${t.spendUsedMusd} µUSD (no cap)`,
  ].join(", ");
  return `${t.id} | ${t.label || "(no label)"} | ${t.status} | expires ${t.expiresAt} | ${caps}`;
}

export function registerProxyTokenTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  const bearer = () => {
    if (!config.apiKey) throw new Error("DOMINUSNODE_API_KEY is required for proxy token tools");
    return config.apiKey;
  };

  server.tool(
    "dominusnode_proxy_token_create",
    "Create a scoped proxy token (POST /v1/proxy-tokens) to use as the proxy password instead of your API key. " +
      "It expires (default 30 days) and can carry a byte cap and a spend cap in µUSD; once a cap is reached the gateway refuses it. " +
      "The token is shown once.",
    {
      label: z.string().max(64).regex(/^[^\u0000-\u001f\u007f]*$/).optional().describe("Label, e.g. 'scraper-ci'"),
      ttl_seconds: z.number().int().min(60).max(365 * 24 * 3600).optional().describe("Lifetime in seconds (default 30 days)"),
      max_bytes: z.string().regex(INT_RE).optional().describe("Byte cap as an integer string (gateway-metered)"),
      max_spend_musd: z.string().regex(INT_RE).optional().describe("Spend cap in integer µUSD as a string (1 USD = 1000000)"),
    },
    async (args) => {
      try {
        if (!limiter.get(server).take()) return rateLimited();
        const body: Record<string, unknown> = {};
        if (args.label !== undefined) body["label"] = args.label;
        if (args.ttl_seconds !== undefined) body["ttlSeconds"] = args.ttl_seconds;
        if (args.max_bytes !== undefined) body["maxBytes"] = args.max_bytes;
        if (args.max_spend_musd !== undefined) body["maxSpendMusd"] = args.max_spend_musd;
        const t = await httpClient.request<ProxyTokenView & { token: string }>({ method: "POST", path: "/v1/proxy-tokens", body, bearer: bearer() });
        if (typeof t.token !== "string" || !TOKEN_RE.test(t.token)) throw new Error("server returned a malformed proxy token");
        return text([
          `Proxy token created: ${describeToken(t)}`,
          `Token: ${t.token}`,
          ``,
          `Use it as the proxy password, e.g. http://country-US:<token>@<proxy-host>:8080 (username carries the flags).`,
          `IMPORTANT: this is the only time the token is shown. Treat it as a secret; revoke it with`,
          `dominusnode_proxy_token_revoke id=${t.id} if it leaks.`,
        ].join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_proxy_token_list",
    "List your proxy tokens (GET /v1/proxy-tokens): id, label, status (active/revoked/expired/exhausted), expiry and cap usage. Secrets are never shown.",
    {},
    async () => {
      try {
        const r = await httpClient.request<{ tokens: ProxyTokenView[]; maxActive: number }>({ method: "GET", path: "/v1/proxy-tokens", bearer: bearer() });
        const tokens = r.tokens ?? [];
        if (tokens.length === 0) return text("No proxy tokens.");
        return text([`Proxy tokens (${tokens.length}, at most ${r.maxActive} active):`, ...tokens.map(describeToken)].join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_proxy_token_revoke",
    "Revoke a proxy token by id (DELETE /v1/proxy-tokens/:id). The gateway refuses it within a few seconds. Cannot be undone.",
    { id: z.string().regex(UUID_RE, "id must be a UUID").describe("Proxy token id") },
    async (args) => {
      try {
        if (!limiter.get(server).take()) return rateLimited();
        await httpClient.request({ method: "DELETE", path: `/v1/proxy-tokens/${encodeURIComponent(args.id)}`, bearer: bearer() });
        return text(`Proxy token ${args.id} revoked.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
