/**
 * DominusNode v2 standard tool set (19 tools), framework-neutral.
 *
 * Every tool is a thin wrapper over @dominusnode/sdk: HTTP, auth modes, SSRF/DNS-rebinding,
 * redirects, the 10 MB cap and credential scrubbing all live in the SDK. This file only
 * describes the tools for an LLM and maps arguments to SDK calls.
 *
 * The API key comes from DOMINUSNODE_API_KEY (or the host framework's credentials store via
 * `apiKey`); it is never a tool argument and never appears in a tool result.
 */
import { DominusNodeClient, scrubCredentials } from "@dominusnode/sdk";

export interface JsonSchemaProperty {
  type: "string" | "integer" | "boolean";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface DominusNodeToolSpec {
  /** Standard v2 name (snake_case), e.g. "network_pricing". */
  name: StandardToolName;
  /** Short human title. */
  title: string;
  description: string;
  parameters: JsonSchemaObject;
  /** True when the tool needs no account (public endpoints / static text). */
  public: boolean;
  run(client: DominusNodeClient, args: Record<string, unknown>): Promise<unknown>;
}

export const STANDARD_TOOL_NAMES = [
  "fetch",
  "proxy_url",
  "network_policy",
  "network_pricing",
  "network_stats",
  "balance",
  "transactions",
  "topup_crypto",
  "check_payment",
  "usage",
  "active_sessions",
  "report_session",
  "node_list",
  "node_tier",
  "node_setup_guide",
  "credits_balance",
  "credits_convert",
  "payouts_list",
  "x402_info",
] as const;
export type StandardToolName = (typeof STANDARD_TOOL_NAMES)[number];

export const CRYPTO_CURRENCIES = ["btc", "eth", "ltc", "xmr", "zec", "usdc", "sol", "usdt", "dai", "bnb", "link"] as const;
export const REPORT_REASONS = ["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"] as const;
export const IP_CLASSES = ["residential", "dc", "mobile", "masked"] as const;

/** Max characters of fetched body returned to the model (the SDK already caps bytes at 10 MB). */
export const MAX_BODY_CHARS = 20_000;
const KEY_PLACEHOLDER = "${DOMINUSNODE_API_KEY}";

export interface DominusNodeToolsConfig {
  /** API key (dn_live_/dn_test_). Defaults to process.env.DOMINUSNODE_API_KEY. Never pass model output here. */
  apiKey?: string;
  /** Defaults to DOMINUSNODE_BASE_URL or https://api.dominusnode.com. */
  baseUrl?: string;
  /** Defaults to DOMINUSNODE_PROXY_HOST or proxy.dominusnode.com. */
  proxyHost?: string;
  /** Defaults to DOMINUSNODE_PROXY_PORT or 8080. */
  httpProxyPort?: number;
  /** Inject a pre-built client (tests, custom transports). */
  client?: DominusNodeClient;
}

function env(name: string): string | undefined {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.trim() ? v.trim() : undefined;
}

/** Lazily connects one SDK client per toolkit; failed connects are retried on the next call. */
export class ClientProvider {
  readonly #client: DominusNodeClient;
  readonly #apiKey: string | undefined;
  #connecting: Promise<DominusNodeClient> | null = null;

  constructor(config: DominusNodeToolsConfig = {}) {
    this.#apiKey = config.apiKey?.trim() || env("DOMINUSNODE_API_KEY");
    if (config.client) {
      this.#client = config.client;
    } else {
      const portEnv = env("DOMINUSNODE_PROXY_PORT");
      const port = config.httpProxyPort ?? (portEnv ? Number.parseInt(portEnv, 10) : undefined);
      this.#client = new DominusNodeClient({
        baseUrl: config.baseUrl ?? env("DOMINUSNODE_BASE_URL"),
        proxyHost: config.proxyHost ?? env("DOMINUSNODE_PROXY_HOST"),
        httpProxyPort: port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined,
      });
    }
  }

  /** Client without credentials (public endpoints). */
  get publicClient(): DominusNodeClient {
    return this.#client;
  }

  /** Connected client (connectWithKey once). */
  async connected(): Promise<DominusNodeClient> {
    if (this.#client.isConnected) return this.#client;
    if (!this.#apiKey) {
      throw new Error("DOMINUSNODE_API_KEY is not set. Configure it in the environment or the credentials store.");
    }
    if (!this.#connecting) {
      const key = this.#apiKey;
      this.#connecting = this.#client.connectWithKey(key).then(
        () => this.#client,
        (err) => {
          this.#connecting = null;
          throw err;
        },
      );
    }
    return this.#connecting;
  }

  async disconnect(): Promise<void> {
    this.#connecting = null;
    await this.#client.disconnect();
  }

  toString(): string {
    return "ClientProvider([REDACTED])";
  }
  toJSON(): Record<string, unknown> {
    return { configured: this.#apiKey !== undefined };
  }
}

// ---------------------------------------------------------------------------
// Argument helpers (the SDK validates values; these only coerce types)
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, k: string): string | undefined {
  const v = args[k];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}
function reqStr(args: Record<string, unknown>, k: string): string {
  const v = str(args, k);
  if (v === undefined) throw new Error(`${k} is required`);
  return v;
}
function int(args: Record<string, unknown>, k: string): number | undefined {
  const v = args[k];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw new Error(`${k} must be an integer`);
  return n;
}
function reqInt(args: Record<string, unknown>, k: string): number {
  const n = int(args, k);
  if (n === undefined) throw new Error(`${k} is required`);
  return n;
}
function bool(args: Record<string, unknown>, k: string): boolean | undefined {
  const v = args[k];
  if (v === undefined || v === null || v === "") return undefined;
  return v === true || v === "true";
}

function obj(properties: Record<string, JsonSchemaProperty>, required: string[] = []): JsonSchemaObject {
  return { type: "object", properties, required, additionalProperties: false };
}

const routing = {
  country: {
    type: "string",
    description:
      "Optional ISO 3166-1 alpha-2 exit country, e.g. US, DE, JP. Sanctioned countries (CU, IR, KP, RU, SY) are refused. " +
      "Use network_stats to see which countries have online nodes.",
  },
  ip_class: {
    type: "string",
    enum: IP_CLASSES,
    description: "Optional exit IP class. Prices differ per class: read network_pricing. masked = cheapest, VPN/anonymizer exits, opt-in. Omit to let the relay choose (never masked).",
  },
  session_id: {
    type: "string",
    description: "Optional sticky-session id (1-64 letters/digits): reuse it to keep the same exit IP across requests.",
  },
  allow_http: {
    type: "boolean",
    description:
      "Opt in to plaintext http:// targets. The exit node can see and modify plaintext traffic, so only use it for public, " +
      "non-sensitive pages. https:// is always end-to-end encrypted through the relay.",
  },
} as const satisfies Record<string, JsonSchemaProperty>;

function routingOpts(args: Record<string, unknown>) {
  return {
    country: str(args, "country")?.toUpperCase(),
    ipClass: str(args, "ip_class") as (typeof IP_CLASSES)[number] | undefined,
    sessionId: str(args, "session_id"),
    allowHttp: bool(args, "allow_http"),
  };
}

const limitProp = (max: number): JsonSchemaProperty => ({ type: "integer", minimum: 1, maximum: max, description: `Optional page size (1-${max}).` });
const offsetProp: JsonSchemaProperty = { type: "integer", minimum: 0, description: "Optional offset for paging (default 0)." };

export const NODE_SETUP_GUIDE = [
  "DominusNode relay node setup (earn by contributing an IP)",
  "",
  "How earning works",
  "  - A node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.",
  "  - You earn your tier's share of each paid GB relayed; live prices and node shares are in network_pricing.",
  "    Earnings accrue as pending credit, mature, then become available (credits_balance).",
  "  - Self-dealing earns nothing: your own, your wallet's, your team's or your /24's traffic is never routed to your node.",
  "  - Tiers rise with paid tenure, uptime, active IPs and reputation; check node_tier.",
  "  - The node floor is fixed: ports 80/443 only, no private/metadata targets, no payload logging (network_policy).",
  "",
  "Prerequisites",
  "  - A wallet-linked account and a personal dn_live_ API key (team keys cannot run nodes).",
  "  - Node.js >= 18 and git on the machine whose IP you contribute. IPs in sanctioned countries cannot join.",
  "",
  "Step 1: Store the owner wallet key in a private file (never paste it into a chat or a command line)",
  "  umask 077 && mkdir -p ~/.dominusnode && printf '%s' \"$WALLET_PRIVATE_KEY_HEX\" > ~/.dominusnode/wallet.key",
  "",
  "Step 2: Register the node with the node agent CLI (signing happens locally, not through this tool set)",
  "  git clone https://github.com/0xcircuitbreaker/DomiNode.git && cd DomiNode",
  "  npm ci && npm run build -w @dominusnode/shared -w @dominusnode/node-agent",
  "  export DN_API_KEY   # your dn_live_ key, from the environment only",
  "  node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key",
  "  (or use the DominusNode MCP server's node_register tool / the SDK's nodes.register with a signer)",
  "",
  "Step 3: Run the node agent on the machine that owns the IP",
  "  node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json",
  "  Optional limits: --ports 443 --max-streams 32 --gb-per-day 5 --req-per-sec 20",
  "  Keep it running (systemd, pm2 or a container restart policy): uptime drives your tier.",
  "",
  "Step 4: Verify with node_list (status, observed IP, class, last seen) and node_tier.",
  "Withdrawals and payout-wallet changes need a wallet signature: use the MCP server or the SDK with a signer key file.",
].join("\n");

// ---------------------------------------------------------------------------
// The 19 tools
// ---------------------------------------------------------------------------

export function createToolSpecs(): DominusNodeToolSpec[] {
  return [
    {
      name: "fetch",
      title: "Fetch URL via relay",
      public: false,
      description:
        "Fetch a public web page through the DominusNode relay network (real residential, datacenter or mobile exit IPs " +
        "contributed by node operators). GET or HEAD only; ports 80/443; private, local and DNS-rebinding targets are refused; " +
        "redirects are returned, not followed; body capped at 10 MB. https:// is the default; http:// needs allow_http " +
        "(plaintext is visible to the exit node). Billed per GB from the prepaid wallet at the rates in network_pricing.",
      parameters: obj(
        {
          url: { type: "string", description: "Absolute https:// (or http:// with allow_http) URL of a public page." },
          method: { type: "string", enum: ["GET", "HEAD"], description: "GET (default) or HEAD." },
          ...routing,
        },
        ["url"],
      ),
      async run(client, args) {
        const method = (str(args, "method") ?? "GET").toUpperCase() as "GET" | "HEAD";
        const res = await client.proxy.fetch(reqStr(args, "url"), { method, ...routingOpts(args) });
        const text = method === "HEAD" ? "" : res.text();
        return {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          body: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text,
          truncated: res.truncated || text.length > MAX_BODY_CHARS,
        };
      },
    },
    {
      name: "proxy_url",
      title: "Build proxy URL",
      public: false,
      description:
        "Build a proxy URL for HTTP clients (curl, browsers, scrapers) that route through the relay. Routing flags go in the " +
        "username (country-XX, class-..., session-..., allowhttp-1). The API key is NOT included: the result contains the " +
        "placeholder ${DOMINUSNODE_API_KEY}, which the caller substitutes from its own environment.",
      parameters: obj({
        ...routing,
        protocol: { type: "string", enum: ["http", "socks5"], description: "http (default; CONNECT for https) or socks5." },
      }),
      async run(client, args) {
        const protocol = (str(args, "protocol") ?? "http") as "http" | "socks5";
        const url = client.proxy.buildUrl({ ...routingOpts(args), protocol });
        // Replace the password section with a placeholder; scrubbing is a second line of defence.
        const masked = scrubCredentials(url.replace(/^([a-z0-9]+:\/\/[^:]*:)[^@]*@/i, `$1${KEY_PLACEHOLDER}@`));
        return { proxyUrl: masked, username: client.proxy.buildUsername(routingOpts(args)), protocol };
      },
    },
    {
      name: "network_policy",
      title: "Network policy",
      public: true,
      description:
        "Read the relay network's current acceptable-use policy (version, sha256, body) and the fixed floor guarantees " +
        "every node enforces (ports, blocked targets, no payload logging). Public; no account needed.",
      parameters: obj({}),
      run: (client) => client.network.policy(),
    },
    {
      name: "network_pricing",
      title: "Network pricing",
      public: true,
      description:
        "Live per-GB prices for each exit IP class (in µUSD per GB; 1 USD = 1,000,000 µUSD), the node operators' revenue " +
        "share per tier, the earnings maturation period and accepted payment rails. Always use this instead of assuming prices.",
      parameters: obj({}),
      run: (client) => client.network.pricing(),
    },
    {
      name: "network_stats",
      title: "Network stats",
      public: true,
      description: "Count of online relay nodes by IP class and by country. Use it to pick a country/class that has capacity.",
      parameters: obj({}),
      run: (client) => client.network.stats(),
    },
    {
      name: "balance",
      title: "Wallet balance",
      public: false,
      description: "Prepaid wallet balance (cents and USD) that pays for relay traffic.",
      parameters: obj({}),
      run: (client) => client.wallet.getBalance(),
    },
    {
      name: "transactions",
      title: "Wallet transactions",
      public: false,
      description: "Recent prepaid wallet transactions (top-ups, usage charges, credit conversions).",
      parameters: obj({ limit: limitProp(100), offset: offsetProp }),
      run: (client, args) => client.wallet.getTransactions({ limit: int(args, "limit"), offset: int(args, "offset") }),
    },
    {
      name: "topup_crypto",
      title: "Top up with crypto",
      public: false,
      description:
        "Create a crypto invoice to top up the prepaid wallet. Returns an invoice id and a payment URL for a human or wallet " +
        "to pay; nothing is charged by this call. Amount 1000-100000 cents ($10-$1,000). Track it with check_payment.",
      parameters: obj(
        {
          amount_cents: { type: "integer", minimum: 1000, maximum: 100000, description: "Amount in US cents (1000-100000)." },
          currency: { type: "string", enum: CRYPTO_CURRENCIES, description: "Coin to pay with." },
        },
        ["amount_cents", "currency"],
      ),
      run: (client, args) => client.wallet.topUpCrypto(reqInt(args, "amount_cents"), reqStr(args, "currency")),
    },
    {
      name: "check_payment",
      title: "Check crypto payment",
      public: false,
      description: "Status of a crypto top-up invoice created by topup_crypto (waiting, confirming, finished, ...).",
      parameters: obj({ invoice_id: { type: "string", description: "Invoice UUID from topup_crypto." } }, ["invoice_id"]),
      run: (client, args) => client.wallet.getCryptoStatus(reqStr(args, "invoice_id")),
    },
    {
      name: "usage",
      title: "Usage summary",
      public: false,
      description: "Bandwidth usage and cost summary with recent records for a date range (defaults to the server's window).",
      parameters: obj({
        from: { type: "string", description: "Optional ISO 8601 start, e.g. 2026-01-01T00:00:00Z." },
        to: { type: "string", description: "Optional ISO 8601 end." },
        limit: limitProp(1000),
      }),
      run: (client, args) => client.usage.get({ from: str(args, "from"), to: str(args, "to"), limit: int(args, "limit") }),
    },
    {
      name: "active_sessions",
      title: "Active sessions",
      public: false,
      description: "Currently open relay sessions (id, start time, status).",
      parameters: obj({}),
      run: (client) => client.sessions.getActive(),
    },
    {
      name: "report_session",
      title: "Report bad session",
      public: false,
      description:
        "Report a relay session whose exit node misbehaved (blocked, captcha, rate_limited, slow, bad_content, other). " +
        "Reports feed node reputation; there is a daily limit.",
      parameters: obj(
        {
          session_id: { type: "string", description: "Relay session UUID." },
          reason: { type: "string", enum: REPORT_REASONS, description: "What went wrong." },
        },
        ["session_id", "reason"],
      ),
      run: (client, args) =>
        client.sessions.report(reqStr(args, "session_id"), reqStr(args, "reason") as (typeof REPORT_REASONS)[number]),
    },
    {
      name: "node_list",
      title: "My relay nodes",
      public: false,
      description:
        "List the relay nodes you contribute (status, observed IP, country, class, caps, reputation, last seen). " +
        "To add one, see node_setup_guide.",
      parameters: obj({ limit: limitProp(500), offset: offsetProp }),
      run: (client, args) => client.nodes.list({ limit: int(args, "limit"), offset: int(args, "offset") }),
    },
    {
      name: "node_tier",
      title: "Node operator tier",
      public: false,
      description: "Your node-operator tier, the next tier and progress toward it (tier sets your revenue share and withdraw limit).",
      parameters: obj({}),
      run: (client) => client.nodes.tier(),
    },
    {
      name: "node_setup_guide",
      title: "Node setup guide",
      public: true,
      description:
        "Step-by-step instructions to earn credit by contributing an IP with the DominusNode node agent: how earning and " +
        "tiers work, registering a node (signed locally with your wallet key) and running the agent.",
      parameters: obj({}),
      run: async () => ({ guide: NODE_SETUP_GUIDE }),
    },
    {
      name: "credits_balance",
      title: "Node credits",
      public: false,
      description:
        "Node-operator earnings: pending, available and frozen credit (µUSD), tier, withdraw limits and payout status.",
      parameters: obj({}),
      run: (client) => client.credits.balance(),
    },
    {
      name: "credits_convert",
      title: "Convert credits",
      public: false,
      description:
        "Convert available node credit into prepaid wallet balance to pay for your own relay traffic. Amount in µUSD " +
        "(10,000 = $0.01 up to 10,000,000,000). Pass the same idempotency_key to retry safely.",
      parameters: obj(
        {
          amount_musd: { type: "string", description: "Amount in µUSD as a whole-number string, e.g. \"5000000\" for $5." },
          idempotency_key: { type: "string", description: "Optional 8-120 chars [A-Za-z0-9_-]; generated when omitted." },
        },
        ["amount_musd"],
      ),
      run: (client, args) =>
        client.credits.convert(reqStr(args, "amount_musd"), { idempotencyKey: str(args, "idempotency_key") }),
    },
    {
      name: "payouts_list",
      title: "Payouts",
      public: false,
      description: "On-chain payout history for node earnings (amount, status, tx hash). Withdrawals themselves need a wallet signature and are not available here.",
      parameters: obj({ limit: limitProp(200), offset: offsetProp }),
      run: (client, args) => client.payouts.list({ limit: int(args, "limit"), offset: int(args, "offset") }),
    },
    {
      name: "x402_info",
      title: "x402 info",
      public: true,
      description: "x402 (HTTP 402 micropayment) support: facilitators, networks, currencies and per-request pricing.",
      parameters: obj({}),
      run: (client) => client.x402.getInfo(),
    },
  ];
}

/** Recursively scrub credentials from every string in a result. */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 50) return "[TRUNCATED]";
  if (typeof value === "string") return scrubCredentials(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = scrubDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Error text safe to show a model. */
export function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string" ? ` (${(err as { code: string }).code})` : "";
  return `Error: ${scrubCredentials(raw)}${code}`;
}

/** Run a tool and return a JSON string (or a scrubbed "Error: ..." string). Never throws. */
export async function runTool(spec: DominusNodeToolSpec, provider: ClientProvider, args: unknown): Promise<string> {
  try {
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const client = spec.public ? provider.publicClient : await provider.connected();
    const result = await spec.run(client, a);
    return JSON.stringify(scrubDeep(result), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch (err) {
    return safeError(err);
  }
}
