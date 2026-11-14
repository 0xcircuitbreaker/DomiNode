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
  type: "string", enum: ["residential", "dc", "mobile", "masked"],
  description: "Exit IP class. Each class has its own per-GB price (see network_pricing); masked = cheapest, VPN/anonymizer exits, opt-in.",
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
      protocol: {
        type: "string", enum: ["https", "socks5", "http"],
        description: "https (default: TLS to the gateway), socks5, or http (plaintext gateway; local dev only).",
      },
    }) },
  { name: "network_policy", description:
      "Relay network policy: allowed ports, plaintext (allowhttp) rules, blocked ranges, sanctioned countries " +
      "and node attestation terms.", parameters: obj() },
  { name: "network_pricing", description:
      "Live per-GB prices by exit IP class (residential, dc, mobile, masked) and node tier revenue shares. Always use " +
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
      "Explains how to convert node credits into wallet balance. Conversion needs a wallet signature, so it runs through the DominusNode MCP server or SDK with a signer key file, not through this tool.",
    parameters: obj({ amount_musd: { type: "string", description: "Amount in micro-USD as a digit string (min 10000 = $0.01)." } }, ["amount_musd"]) },
  { name: "payouts_list", description: "Your USDC payouts of node earnings with status and transaction hash.",
    parameters: obj({ limit: LIMIT, offset: OFFSET }) },
  { name: "x402_info", description: "x402 micropayment info: facilitators, networks and server-reported prices.", parameters: obj() },
];

export const TOOL_NAMES: string[] = TOOL_SPECS.map((t) => t.name);
const SPECS = new Map(TOOL_SPECS.map((t) => [t.name, t]));

/** credits_convert needs a wallet signature; signing flows are not exposed as LLM tools. */
export const CREDITS_CONVERT_SIGNING_MESSAGE =
  "Converting credits needs a fresh signature from the wallet linked to this account, so this tool does not convert. Use the DominusNode MCP server (tool dominusnode_credits_convert, with DOMINUSNODE_WALLET_KEY_FILE pointing at a chmod-600 wallet key file) or a DominusNode SDK's credits.convert with a signer key file. Check available credit with credits_balance.";

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
  "  2. On the machine whose IP you contribute (Docker), register with the published image",
  "     (official coordinator pins baked in; a plain source build has none and refuses to start):",
  "     sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode",
  "     sudo install -o 1001 -g 1001 -m 600 ~/.dominusnode/wallet.key /etc/dominusnode/wallet.key",
  "     export DN_API_KEY   # your dn_live_ key, from the environment only",
  "     docker run --rm -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key \\",
  "       -v /etc/dominusnode:/run/dominusnode ghcr.io/0xcircuitbreaker/dominusnode-node register",
  "     sudo rm /etc/dominusnode/wallet.key   # not needed after registration",
  "  3. Run it and keep it running - uptime drives your tier:",
  "     docker run -d --name dominusnode-node --restart unless-stopped \\",
  "       -v /etc/dominusnode/node.json:/run/dominusnode/node.json:ro ghcr.io/0xcircuitbreaker/dominusnode-node",
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

/** Gateway TLS port: production 8443; self-hosted coordinators use 8443 too. */
export const DEFAULT_TLS_PROXY_PORT = 8443;

/**
 * Where proxy traffic goes. TLS to the gateway's HTTPS proxy is the default (production refuses
 * credentials on plaintext 8080/1080). DOMINUSNODE_PROXY_URL=https://host[:port] sets host and TLS
 * port (same variable as the MCP server); DOMINUSNODE_PROXY_INSECURE=1 selects plaintext (local dev).
 */
export function resolveGateway(
  config: { proxyHost?: string; tlsProxyPort?: number; httpProxyPort?: number; insecureProxy?: boolean },
  getEnv: (name: string) => string | undefined,
): { proxyHost?: string; httpProxyPort?: number; gatewayTls: false | { port: number } } {
  const validPort = (p: number | undefined): number | undefined =>
    p !== undefined && Number.isInteger(p) && p >= 1 && p <= 65535 ? p : undefined;
  let urlHost: string | undefined;
  let urlPort: number | undefined;
  const raw = getEnv("DOMINUSNODE_PROXY_URL");
  if (raw) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("DOMINUSNODE_PROXY_URL is not a valid URL");
    }
    if (u.protocol !== "https:") throw new Error("DOMINUSNODE_PROXY_URL must use https:// (TLS to the gateway)");
    if (u.username || u.password) throw new Error("DOMINUSNODE_PROXY_URL must not contain credentials");
    urlHost = u.hostname.toLowerCase();
    urlPort = u.port ? validPort(Number(u.port)) : DEFAULT_TLS_PROXY_PORT;
  }
  const insecure = config.insecureProxy ?? getEnv("DOMINUSNODE_PROXY_INSECURE") === "1";
  if (insecure && raw) throw new Error("DOMINUSNODE_PROXY_URL (TLS) and DOMINUSNODE_PROXY_INSECURE=1 are mutually exclusive");
  const portEnv = getEnv("DOMINUSNODE_PROXY_PORT");
  const httpProxyPort = validPort(config.httpProxyPort ?? (portEnv ? Number.parseInt(portEnv, 10) : undefined));
  const tlsEnv = getEnv("DOMINUSNODE_PROXY_TLS_PORT");
  const tlsPort =
    validPort(config.tlsProxyPort) ?? urlPort ?? validPort(tlsEnv ? Number.parseInt(tlsEnv, 10) : undefined) ?? DEFAULT_TLS_PROXY_PORT;
  return {
    proxyHost: config.proxyHost ?? urlHost ?? getEnv("DOMINUSNODE_PROXY_HOST"),
    httpProxyPort,
    gatewayTls: insecure ? false : { port: tlsPort },
  };
}

export interface DominusNodeToolsConfig {
  /** Defaults to process.env.DOMINUSNODE_API_KEY. Never pass it from model output. */
  apiKey?: string;
  baseUrl?: string;
  /** Defaults to the DOMINUSNODE_PROXY_URL host, DOMINUSNODE_PROXY_HOST or the SDK default. */
  proxyHost?: string;
  /** Gateway TLS (HTTPS proxy) port. Defaults to the DOMINUSNODE_PROXY_URL port, DOMINUSNODE_PROXY_TLS_PORT or 8443. */
  tlsProxyPort?: number;
  /** Plaintext port, used only with insecureProxy. Defaults to DOMINUSNODE_PROXY_PORT or 8080. */
  httpProxyPort?: number;
  /** Plaintext to the gateway (local dev only; production refuses it). Defaults to DOMINUSNODE_PROXY_INSECURE=1. */
  insecureProxy?: boolean;
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
  #gateway: ReturnType<typeof resolveGateway>;

  constructor(config: DominusNodeToolsConfig = {}) {
    this.#apiKey = config.apiKey || process.env.DOMINUSNODE_API_KEY || undefined;
    this.#baseUrl = config.baseUrl || process.env.DOMINUSNODE_BASE_URL || undefined;
    this.#gateway = resolveGateway(config, (k) => process.env[k]?.trim() || undefined);
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
        ...(this.#gateway.proxyHost ? { proxyHost: this.#gateway.proxyHost } : {}),
        ...(this.#gateway.httpProxyPort ? { httpProxyPort: this.#gateway.httpProxyPort } : {}),
        gatewayTls: this.#gateway.gatewayTls,
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
      ipClass: optStr(a, "ip_class") as "residential" | "dc" | "mobile" | "masked" | undefined,
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
        const protocol = optStr(a, "protocol") as "https" | "http" | "socks5" | undefined;
        const url = c.proxy.buildUrl({ ...routing, ...(protocol ? { protocol } : {}) });
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
      case "credits_convert": return { status: "signing_required", message: CREDITS_CONVERT_SIGNING_MESSAGE };
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
