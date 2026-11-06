/**
 * DominusNode v2 standard tool set (19 tools), built on `@dominusnode/sdk`.
 *
 * Framework-neutral: each tool has a name, an LLM-facing description and a JSON Schema for its arguments.
 * `DominusNodeTools.call(name, args)` dispatches to the SDK and always resolves to a JSON string with
 * credentials scrubbed. HTTP, SSRF/DNS-rebinding checks, OFAC refusal and signing all live in the SDK.
 * The API key comes from config or DOMINUSNODE_API_KEY only; it is never a tool argument or output.
 */
import { DominusNodeClient, scrubCredentials } from "@dominusnode/sdk";

export const PREFIX = "dominusnode_";
export const MAX_BODY_CHARS = 20_000;
const KEY_PLACEHOLDER = "${DOMINUSNODE_API_KEY}";

export interface JsonSchemaProp {
  type: "string" | "integer" | "boolean";
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}
export interface ToolSpec {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, JsonSchemaProp>; required: string[]; additionalProperties: false };
}

const COUNTRY: JsonSchemaProp = { type: "string", description: "ISO 3166-1 alpha-2 exit country, e.g. US. Sanctioned countries are refused." };
const IP_CLASS: JsonSchemaProp = {
  type: "string", enum: ["residential", "dc", "mobile"],
  description: "Exit IP class. Each class has its own per-GB price (see network_pricing).",
};
const SESSION: JsonSchemaProp = { type: "string", description: "Sticky session id (1-64 alphanumeric) to keep the same exit IP." };
const ALLOW_HTTP: JsonSchemaProp = {
  type: "boolean", description: "Opt in to plaintext http:// targets. Plaintext is visible to the exit node; prefer https.",
};
const LIMIT: JsonSchemaProp = { type: "integer", minimum: 1, description: "Maximum number of items." };
const OFFSET: JsonSchemaProp = { type: "integer", minimum: 0, description: "Items to skip." };

function obj(properties: Record<string, JsonSchemaProp> = {}, required: string[] = []): ToolSpec["parameters"] {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOL_SPECS: ToolSpec[] = [
  { name: "fetch", description:
      "Fetch a public URL through the DominusNode relay network (GET or HEAD only, ports 80/443, no redirects " +
      "followed, 10 MB cap, private/internal targets refused). Billed per GB at the live price for the exit IP " +
      "class (see network_pricing). http:// targets need allow_http=true and are visible to the exit node.",
    parameters: obj({
      url: { type: "string", description: "https:// URL (or http:// with allow_http)." },
      method: { type: "string", enum: ["GET", "HEAD"], description: "HTTP method." },
      country: COUNTRY, ip_class: IP_CLASS, session_id: SESSION, allow_http: ALLOW_HTTP,
    }, ["url"]) },
  { name: "proxy_url", description:
      "Build a relay gateway proxy URL for use in other HTTP clients. Routing flags go in the username " +
      "(country-XX, class-..., session-..., allowhttp-1). The password is shown as a ${DOMINUSNODE_API_KEY} " +
      "placeholder: substitute the key from the environment, never paste it into chat.",
    parameters: obj({
      country: COUNTRY, ip_class: IP_CLASS, session_id: SESSION, allow_http: ALLOW_HTTP,
      protocol: { type: "string", enum: ["http", "socks5"], description: "Proxy protocol." },
    }) },
  { name: "network_policy", description:
      "Relay network policy: allowed ports, plaintext (allowhttp) rules, blocked ranges, sanctioned countries " +
      "and node attestation terms.", parameters: obj() },
  { name: "network_pricing", description:
      "Live per-GB prices by exit IP class (residential, dc, mobile) and node tier revenue shares. Always use " +
      "this for prices; never assume them.", parameters: obj() },
  { name: "network_stats", description: "Relay network statistics: online nodes, exit countries and IP classes.", parameters: obj() },
  { name: "balance", description: "Prepaid requester wallet balance (cents) used to pay for relayed traffic.", parameters: obj() },
  { name: "transactions", description: "Requester wallet transaction history (top-ups, usage debits, credit conversions).",
    parameters: obj({ limit: LIMIT, offset: OFFSET }) },
  { name: "topup_crypto", description:
      "Create a crypto invoice to top up the requester wallet ($10-$1,000). Returns a payment address/URL; " +
      "the wallet is credited after on-chain confirmation (check with check_payment).",
    parameters: obj({
      amount_cents: { type: "integer", minimum: 1000, maximum: 100000, description: "Amount in US cents (1000 = $10)." },
      currency: { type: "string", enum: ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"],
        description: "Cryptocurrency to pay with." },
    }, ["amount_cents", "currency"]) },
  { name: "check_payment", description: "Status of a crypto top-up invoice created by topup_crypto.",
    parameters: obj({ invoice_id: { type: "string", description: "Invoice UUID." } }, ["invoice_id"]) },
  { name: "usage", description: "Relayed traffic usage summary (bytes and cost) for an optional ISO 8601 date range.",
    parameters: obj({ from: { type: "string", description: "ISO 8601 start." }, to: { type: "string", description: "ISO 8601 end." } }) },
  { name: "active_sessions", description: "Your currently active relay sessions (id, start time, status).", parameters: obj() },
  { name: "report_session", description: "Report a burned or bad exit for one of your relay sessions so the network can rotate it.",
    parameters: obj({
      session_id: { type: "string", description: "Session UUID from active_sessions." },
      reason: { type: "string", enum: ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"], description: "Why the exit is bad." },
    }, ["session_id", "reason"]) },
  { name: "node_list", description: "Relay nodes you contribute (status, observed IP class, last seen). Contributing IPs earns credit.",
    parameters: obj({ limit: LIMIT, offset: OFFSET }) },
  { name: "node_tier", description:
      "Your node-operator tier, revenue share and progress toward the next tier (tenure, uptime, active IPs, reputation).",
    parameters: obj() },
  { name: "node_setup_guide", description:
      "Step-by-step instructions to earn by contributing an IP: run the DominusNode node agent, register a node, " +
      "and how tiers and the self-dealing rule work.", parameters: obj() },
  { name: "credits_balance", description: "Node-operator earnings: pending and available credit (µUSD).", parameters: obj() },
  { name: "credits_convert", description:
      "Convert available node earnings into your own requester wallet balance (idempotent; returns the idempotency key).",
    parameters: obj({ amount_musd: { type: "string", description: "Amount in micro-USD as a digit string (min 10000 = $0.01)." } }, ["amount_musd"]) },
  { name: "payouts_list", description: "Your USDC payouts of node earnings with status and transaction hash.",
    parameters: obj({ limit: LIMIT, offset: OFFSET }) },
  { name: "x402_info", description: "x402 micropayment info: facilitators, networks and server-reported prices.", parameters: obj() },
];

export const TOOL_NAMES: string[] = TOOL_SPECS.map((t) => t.name);
const SPECS = new Map(TOOL_SPECS.map((t) => [t.name, t]));

export const NODE_SETUP_GUIDE = [
  "DominusNode relay node setup (earn by contributing an IP)",
  "",
  "How earning works",
  "  - Your node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.",
  "  - You earn your tier's share of each paid GB relayed; live prices and shares: network_pricing.",
  "  - Self-dealing earns nothing: your own, your wallet's, team's or /24's traffic never routes to your node.",
  "  - Tiers rise with paid tenure, uptime, active IPs and reputation (node_tier).",
  "  - Nodes only dial ports 80/443, never private/metadata targets or SMTP/SSH/RDP (network_policy).",
  "",
  "Steps",
  "  1. Store your owner wallet key in a private file (never pass it to a tool or chat):",
  "     umask 077 && printf '%s' \"$WALLET_PRIVATE_KEY_HEX\" > ~/.dominusnode/wallet.key",
  "  2. On the machine whose IP you contribute (Node.js >= 18):",
  "     git clone https://github.com/0xcircuitbreaker/DomiNode.git && cd DomiNode",
  "     npm ci && npm run build -w @dominusnode/shared -w @dominusnode/node-agent",
  "     export DN_API_KEY   # your dn_live_ key, from the environment only",
  "     node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key",
  "  3. Run it and keep it running (systemd/pm2) - uptime drives your tier:",
  "     node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json",
  "  4. Verify with node_list and node_tier; earnings appear in credits_balance.",
  "",
  "Signing flows (node register, withdraw, payout wallet) are not available as tools here; use the",
  "node agent CLI, the DominusNode MCP server or the SDK with a signer key file.",
].join("\n");

/** The subset of the SDK client the tools use (lets tests inject a mock). */
export type SdkClient = Pick<
  DominusNodeClient,
  "connectWithKey" | "proxy" | "network" | "wallet" | "usage" | "sessions" | "nodes" | "credits" | "payouts" | "x402"
>;

export interface DominusNodeToolsConfig {
  /** Defaults to process.env.DOMINUSNODE_API_KEY. Never pass it from model output. */
  apiKey?: string;
  baseUrl?: string;
  proxyHost?: string;
  /** Pre-built SDK client (already connected unless `connect` is true). */
  client?: SdkClient;
  /** With `client`: still call connectWithKey(apiKey) before first use. */
  connect?: boolean;
}

type Args = Record<string, unknown>;

function optInt(a: Args, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${k} must be an integer`);
  return v;
}
function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  return v === undefined || v === null ? undefined : String(v);
}

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

export class DominusNodeTools {
  #apiKey: string | undefined;
  #client: SdkClient | undefined;
  #connected: Promise<void> | undefined;
  #baseUrl: string | undefined;
  #proxyHost: string | undefined;

  constructor(config: DominusNodeToolsConfig = {}) {
    this.#apiKey = config.apiKey || process.env.DOMINUSNODE_API_KEY || undefined;
    this.#baseUrl = config.baseUrl || process.env.DOMINUSNODE_BASE_URL || undefined;
    this.#proxyHost = config.proxyHost || process.env.DOMINUSNODE_PROXY_HOST || undefined;
    if (config.client) {
      this.#client = config.client;
      if (!config.connect) this.#connected = Promise.resolve();
    }
  }

  toString(): string { return "DominusNodeTools(apiKey=[REDACTED])"; }
  toJSON(): Record<string, string> { return { apiKey: "[REDACTED]" }; }

  async #sdk(): Promise<SdkClient> {
    if (!this.#client) {
      this.#client = new DominusNodeClient({
        ...(this.#baseUrl ? { baseUrl: this.#baseUrl } : {}),
        ...(this.#proxyHost ? { proxyHost: this.#proxyHost } : {}),
      });
    }
    if (!this.#connected) {
      const key = this.#apiKey;
      if (!key) throw new Error("DOMINUSNODE_API_KEY is not set");
      const client = this.#client;
      this.#connected = client.connectWithKey(key).then(() => undefined);
      this.#connected.catch(() => { this.#connected = undefined; });
    }
    await this.#connected;
    return this.#client;
  }

  async #dispatch(name: string, a: Args): Promise<unknown> {
    if (name === "node_setup_guide") return { guide: NODE_SETUP_GUIDE };
    const c = await this.#sdk();
    const routing = {
      country: optStr(a, "country"),
      ipClass: optStr(a, "ip_class") as "residential" | "dc" | "mobile" | undefined,
      sessionId: optStr(a, "session_id"),
      allowHttp: a.allow_http === true,
    };
    switch (name) {
      case "fetch": {
        const method = (optStr(a, "method") ?? "GET").toUpperCase() as "GET" | "HEAD";
        const r = await c.proxy.fetch(String(a.url), { method, ...routing });
        const body = r.text();
        return {
          status: r.status, statusText: r.statusText,
          contentType: r.headers["content-type"] ?? null, location: r.headers["location"] ?? null,
          truncated: r.truncated || body.length > MAX_BODY_CHARS, body: body.slice(0, MAX_BODY_CHARS),
        };
      }
      case "proxy_url": {
        const protocol = (optStr(a, "protocol") ?? "http") as "http" | "socks5";
        const url = c.proxy.buildUrl({ ...routing, protocol });
        const [scheme, rest] = url.split("://", 2);
        const at = rest.lastIndexOf("@");
        const user = rest.slice(0, at).split(":", 1)[0];
        return {
          proxyUrl: `${scheme}://${user}:${KEY_PLACEHOLDER}@${rest.slice(at + 1)}`,
          username: decodeURIComponent(user),
          note: "Replace the placeholder with DOMINUSNODE_API_KEY from your environment.",
        };
      }
      case "network_policy": return c.network.policy();
      case "network_pricing": return c.network.pricing();
      case "network_stats": return c.network.stats();
      case "balance": return c.wallet.getBalance();
      case "transactions": return c.wallet.getTransactions({ limit: optInt(a, "limit"), offset: optInt(a, "offset") });
      case "topup_crypto": return c.wallet.topUpCrypto(Number(a.amount_cents), String(a.currency));
      case "check_payment": return c.wallet.getCryptoStatus(String(a.invoice_id));
      case "usage": return c.usage.get({ from: optStr(a, "from"), to: optStr(a, "to") });
      case "active_sessions": return c.sessions.getActive();
      case "report_session": return c.sessions.report(String(a.session_id), String(a.reason) as never);
      case "node_list": return c.nodes.list({ limit: optInt(a, "limit"), offset: optInt(a, "offset") });
      case "node_tier": return c.nodes.tier();
      case "credits_balance": return c.credits.balance();
      case "credits_convert": return c.credits.convert(String(a.amount_musd));
      case "payouts_list": return c.payouts.list({ limit: optInt(a, "limit"), offset: optInt(a, "offset") });
      case "x402_info": return c.x402.getInfo();
      default: throw new Error(`unknown tool: ${name}`);
    }
  }

  /** Run a tool by its standard name (prefix optional). Always resolves to a scrubbed JSON string. */
  async call(name: string, args: Args = {}): Promise<string> {
    const tool = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
    const a: Args = {};
    for (const [k, v] of Object.entries(args ?? {})) if (v !== undefined && v !== null) a[k] = v;
    let out: string;
    try {
      const spec = SPECS.get(tool);
      if (!spec) throw new Error(`unknown tool: ${tool}`);
      const unknown = Object.keys(a).filter((k) => !(k in spec.parameters.properties));
      if (unknown.length) throw new Error(`unexpected argument(s): ${unknown.sort().join(", ")}`);
      out = JSON.stringify((await this.#dispatch(tool, a)) ?? null, jsonReplacer);
    } catch (err) {
      const msg = err instanceof Error ? `${err.name === "Error" ? "" : err.name + ": "}${err.message}` : String(err);
      out = JSON.stringify({ error: msg });
    }
    out = scrubCredentials(out);
    if (this.#apiKey) out = out.split(this.#apiKey).join("[REDACTED]");
    return out;
  }
}
