/**
 * Dominus Node — Pi Extension
 *
 * Pi-mono extension providing 26 tools for the Dominus Node rotating proxy
 * and management platform. Loaded by the pi coding agent from:
 *   ~/.pi/agent/extensions/dominusnode/   (global)
 *   .pi/extensions/dominusnode/           (project-local)
 *
 * Usage:
 *   export DOMINUSNODE_API_KEY="dn_live_your_key_here"
 *   # pi agent discovers and loads this extension automatically
 *
 * Or install as a Pi Package:
 *   npm install @dominusnode/pi-extension
 *   # declare in package.json "pi": { "extensions": ["./node_modules/@dominusnode/pi-extension/dist"] }
 *
 * @see https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
 */

import { Type } from "@sinclair/typebox";
import {
  DominusNodeToolkit,
  scrubCredentials,
  isPrivateIp,
  normalizeIpv4,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  stripDangerousKeys,
  checkDnsRebinding,
  truncate,
  formatBytes,
  formatCents,
  SANCTIONED_COUNTRIES,
  BLOCKED_HOSTNAMES,
} from "./toolkit.js";

// Re-export security utilities (used by tests and advanced users)
export {
  DominusNodeToolkit,
  scrubCredentials,
  isPrivateIp,
  normalizeIpv4,
  validateTargetUrl,
  validateCountry,
  validateUuid,
  stripDangerousKeys,
  checkDnsRebinding,
  truncate,
  formatBytes,
  formatCents,
  SANCTIONED_COUNTRIES,
  BLOCKED_HOSTNAMES,
};

// ---------------------------------------------------------------------------
// Pi ExtensionAPI interface (minimal — avoids depending on pi package at runtime)
// ---------------------------------------------------------------------------

interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (text: string) => void,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

interface ExtensionAPI {
  registerTool(tool: PiTool): void;
}

// ---------------------------------------------------------------------------
// Extension default export — called by Pi on load
// ---------------------------------------------------------------------------

export default function dominusNodeExtension(pi: ExtensionAPI): void {
  const toolkit = new DominusNodeToolkit();

  // ── Tool 1: proxied_fetch ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_proxied_fetch",
    label: "DominusNode: Proxied Fetch",
    description:
      "Fetch a URL through Dominus Node's rotating proxy network (datacenter or residential IPs). " +
      "Use for web scraping, bypassing geo-restrictions, or rotating IPs. " +
      "Only GET, HEAD, and OPTIONS are permitted. Private/internal URLs are blocked.",
    parameters: Type.Object({
      url: Type.String({ description: "Target URL to fetch (http or https only)" }),
      method: Type.Optional(Type.Union([
        Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("OPTIONS"),
      ], { description: "HTTP method (default: GET)" })),
      country: Type.Optional(Type.String({ description: "ISO 3166-1 two-letter country code for geo-targeting (e.g. US, GB, DE)" })),
      proxyType: Type.Optional(Type.Union([
        Type.Literal("dc"), Type.Literal("residential"), Type.Literal("auto"),
      ], { description: "Proxy pool: 'dc' (datacenter, $3/GB), 'residential' ($5/GB), or 'auto' (default: dc)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.proxiedFetch(
        String(params.url ?? ""),
        String(params.method ?? "GET"),
        params.country ? String(params.country) : undefined,
        String(params.proxyType ?? "dc"),
      );
    },
  });

  // ── Tool 2: check_balance ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_check_balance",
    label: "DominusNode: Check Wallet Balance",
    description: "Get the current wallet balance and account details for the Dominus Node account.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return toolkit.checkBalance();
    },
  });

  // ── Tool 3: check_usage ──────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_check_usage",
    label: "DominusNode: Check Bandwidth Usage",
    description: "Get bandwidth usage statistics for the past N days (1–365). Shows bytes consumed by datacenter and residential proxy pools.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Number of days to look back (default: 30, max: 365)", minimum: 1, maximum: 365 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.checkUsage(params.days !== undefined ? Number(params.days) : 30);
    },
  });

  // ── Tool 4: get_proxy_config ─────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_get_proxy_config",
    label: "DominusNode: Get Proxy Config",
    description: "Retrieve the proxy endpoint configuration (host, port, proxy URL format) for manual proxy setup.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return toolkit.getProxyConfig();
    },
  });

  // ── Tool 5: list_sessions ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_list_sessions",
    label: "DominusNode: List Active Sessions",
    description: "List currently active proxy sessions, including their start times and bytes consumed.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return toolkit.listSessions();
    },
  });

  // ── Tool 6: create_agentic_wallet ────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_create_agentic_wallet",
    label: "DominusNode: Create Agentic Wallet",
    description:
      "Create a server-side sub-wallet for an AI agent with an optional per-transaction spending limit. " +
      "Useful for giving sub-agents controlled budgets. Wallets are funded from the main wallet.",
    parameters: Type.Object({
      label: Type.String({ description: "Human-readable name for this wallet (e.g. 'research-agent-1')" }),
      spendingLimitCents: Type.Optional(Type.Number({ description: "Maximum spend per transaction in cents (e.g. 500 = $5.00)", minimum: 1, maximum: 1000000 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.createAgenticWallet(
        String(params.label ?? ""),
        params.spendingLimitCents !== undefined ? Number(params.spendingLimitCents) : undefined,
      );
    },
  });

  // ── Tool 7: fund_agentic_wallet ──────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_fund_agentic_wallet",
    label: "DominusNode: Fund Agentic Wallet",
    description: "Transfer funds from the main wallet to an agentic sub-wallet. Amount in cents (e.g. 1000 = $10.00).",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet to fund" }),
      amountCents: Type.Number({ description: "Amount to transfer in cents (e.g. 1000 = $10.00)", minimum: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.fundAgenticWallet(String(params.walletId ?? ""), Number(params.amountCents));
    },
  });

  // ── Tool 8: check_agentic_balance ────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_check_agentic_balance",
    label: "DominusNode: Check Agentic Wallet Balance",
    description: "Get the balance and details of a specific agentic sub-wallet.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.checkAgenticBalance(String(params.walletId ?? ""));
    },
  });

  // ── Tool 9: list_agentic_wallets ─────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_list_agentic_wallets",
    label: "DominusNode: List Agentic Wallets",
    description: "List all agentic sub-wallets associated with this account.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return toolkit.listAgenticWallets();
    },
  });

  // ── Tool 10: agentic_transactions ───────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_agentic_transactions",
    label: "DominusNode: Agentic Wallet Transactions",
    description: "List recent transactions for an agentic sub-wallet.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet" }),
      limit: Type.Optional(Type.Number({ description: "Number of transactions to return (default: 20, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.agenticTransactions(
        String(params.walletId ?? ""),
        params.limit !== undefined ? Number(params.limit) : 20,
      );
    },
  });

  // ── Tool 11: freeze_agentic_wallet ───────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_freeze_agentic_wallet",
    label: "DominusNode: Freeze Agentic Wallet",
    description: "Freeze an agentic sub-wallet to prevent further spending. The wallet must be unfrozen before it can be deleted.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet to freeze" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.freezeAgenticWallet(String(params.walletId ?? ""));
    },
  });

  // ── Tool 12: unfreeze_agentic_wallet ─────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_unfreeze_agentic_wallet",
    label: "DominusNode: Unfreeze Agentic Wallet",
    description: "Unfreeze a previously frozen agentic sub-wallet to resume spending.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet to unfreeze" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.unfreezeAgenticWallet(String(params.walletId ?? ""));
    },
  });

  // ── Tool 13: delete_agentic_wallet ───────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_delete_agentic_wallet",
    label: "DominusNode: Delete Agentic Wallet",
    description: "Permanently delete an agentic sub-wallet. Any remaining balance is returned to the main wallet. The wallet must be frozen first.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet to delete (must be frozen first)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.deleteAgenticWallet(String(params.walletId ?? ""));
    },
  });

  // ── Tool 14: create_team ─────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_create_team",
    label: "DominusNode: Create Team",
    description: "Create a new team with a shared wallet. Teams allow multiple users or agents to share bandwidth and billing.",
    parameters: Type.Object({
      name: Type.String({ description: "Team name" }),
      maxMembers: Type.Optional(Type.Number({ description: "Maximum number of members (default: 10, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.createTeam(String(params.name ?? ""), params.maxMembers !== undefined ? Number(params.maxMembers) : 10);
    },
  });

  // ── Tool 15: list_teams ──────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_list_teams",
    label: "DominusNode: List Teams",
    description: "List all teams the current account belongs to.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Number of teams to return (default: 20, max: 100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.listTeams(params.limit !== undefined ? Number(params.limit) : 20);
    },
  });

  // ── Tool 16: team_details ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_team_details",
    label: "DominusNode: Team Details",
    description: "Get detailed information about a team, including wallet balance, members, and settings.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.teamDetails(String(params.teamId ?? ""));
    },
  });

  // ── Tool 17: team_fund ───────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_team_fund",
    label: "DominusNode: Fund Team Wallet",
    description: "Transfer funds from the main wallet to a team's shared wallet. Amount in cents.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
      amountCents: Type.Number({ description: "Amount to transfer in cents (e.g. 1000 = $10.00)", minimum: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.teamFund(String(params.teamId ?? ""), Number(params.amountCents));
    },
  });

  // ── Tool 18: team_create_api_key ─────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_team_create_api_key",
    label: "DominusNode: Create Team API Key",
    description: "Generate a new API key scoped to a team. Traffic through this key bills to the team wallet. The key is shown only once.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
      label: Type.String({ description: "Label for the API key (e.g. 'research-agent')" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.teamCreateApiKey(String(params.teamId ?? ""), String(params.label ?? ""));
    },
  });

  // ── Tool 19: team_usage ──────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_team_usage",
    label: "DominusNode: Team Bandwidth Usage",
    description: "Get bandwidth usage statistics for a team over the past N days.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
      days: Type.Optional(Type.Number({ description: "Number of days to look back (default: 30, max: 365)", minimum: 1, maximum: 365 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.teamUsage(String(params.teamId ?? ""), params.days !== undefined ? Number(params.days) : 30);
    },
  });

  // ── Tool 20: update_team ─────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_update_team",
    label: "DominusNode: Update Team",
    description: "Update a team's name or maximum member count.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
      name: Type.Optional(Type.String({ description: "New team name" })),
      maxMembers: Type.Optional(Type.Number({ description: "New maximum member count (1–100)", minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.updateTeam(
        String(params.teamId ?? ""),
        params.name !== undefined ? String(params.name) : undefined,
        params.maxMembers !== undefined ? Number(params.maxMembers) : undefined,
      );
    },
  });

  // ── Tool 21: update_team_member_role ─────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_update_team_member_role",
    label: "DominusNode: Update Team Member Role",
    description: "Promote or demote a team member between 'admin' and 'member' roles.",
    parameters: Type.Object({
      teamId: Type.String({ description: "UUID of the team" }),
      userId: Type.String({ description: "UUID of the user to update" }),
      role: Type.Union([Type.Literal("admin"), Type.Literal("member")], { description: "New role: 'admin' or 'member'" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.updateTeamMemberRole(
        String(params.teamId ?? ""),
        String(params.userId ?? ""),
        String(params.role ?? ""),
      );
    },
  });

  // ── Tool 22: topup_paypal ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_topup_paypal",
    label: "DominusNode: Top Up Wallet via PayPal",
    description: "Create a PayPal checkout session to add funds to the Dominus Node wallet. Returns a payment URL to redirect the user to.",
    parameters: Type.Object({
      amountCents: Type.Number({ description: "Amount to add in cents (min: 500 = $5.00, max: 1,000,000 = $10,000.00)", minimum: 500, maximum: 1000000 }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.topupPaypal(Number(params.amountCents));
    },
  });

  // ── Tool 23: topup_stripe ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_topup_stripe",
    label: "DominusNode: Top Up Wallet via Stripe",
    description: "Create a Stripe checkout session to add funds to the Dominus Node wallet. Supports cards and Link. Returns a payment URL.",
    parameters: Type.Object({
      amountCents: Type.Number({ description: "Amount to add in cents (min: 500 = $5.00, max: 1,000,000 = $10,000.00)", minimum: 500, maximum: 1000000 }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.topupStripe(Number(params.amountCents));
    },
  });

  // ── Tool 24: topup_crypto ────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_topup_crypto",
    label: "DominusNode: Top Up Wallet via Crypto",
    description:
      "Create a cryptocurrency invoice to add funds to the Dominus Node wallet. " +
      "Supported currencies: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK. " +
      "Returns a payment address and invoice details.",
    parameters: Type.Object({
      amountUsd: Type.Number({ description: "Amount in USD (min: $5, max: $10,000)", minimum: 5, maximum: 10000 }),
      currency: Type.String({ description: "Crypto currency code: BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, or LINK" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.topupCrypto(Number(params.amountUsd), String(params.currency ?? ""));
    },
  });

  // ── Tool 25: x402_info ───────────────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_x402_info",
    label: "DominusNode: x402 Micropayment Info",
    description:
      "Get x402 micropayment configuration: payment facilitator addresses, supported chains (Base, Polygon, Solana, etc.), " +
      "USDC contract addresses, and price-per-request details for autonomous agent payments.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      return toolkit.x402Info();
    },
  });

  // ── Tool 26: update_wallet_policy ────────────────────────────────────────

  pi.registerTool({
    name: "dominusnode_update_wallet_policy",
    label: "DominusNode: Update Agentic Wallet Policy",
    description: "Update spending policy for an agentic sub-wallet: set a daily spending limit or restrict it to allowed domains.",
    parameters: Type.Object({
      walletId: Type.String({ description: "UUID of the agentic wallet" }),
      dailyLimitCents: Type.Optional(Type.Number({ description: "Daily spending limit in cents (0 = no limit)", minimum: 0, maximum: 1000000 })),
      allowedDomains: Type.Optional(Type.Array(Type.String(), { description: "List of domains this wallet is permitted to make requests to (e.g. ['example.com', 'api.service.io'])" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      return toolkit.updateWalletPolicy(
        String(params.walletId ?? ""),
        params.dailyLimitCents !== undefined ? Number(params.dailyLimitCents) : undefined,
        params.allowedDomains !== undefined ? (params.allowedDomains as string[]) : undefined,
      );
    },
  });
}
