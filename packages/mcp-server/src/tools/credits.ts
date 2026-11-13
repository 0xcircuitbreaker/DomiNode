/**
 * Earnings tools for node operators (docs/agent-network/AGENT_API.md):
 * credits balance/ledger/convert, payout wallet, withdraw, payouts, node caps
 * and session burn reports.
 *
 * Secrets: signing keys are read only from files named by env
 * (DOMINUSNODE_WALLET_KEY_FILE for the linked wallet,
 * DOMINUSNODE_PAYOUT_WALLET_KEY_FILE for the current payout wallet on a
 * change), never from tool arguments. Server messages are rebuilt locally and
 * must match exactly before anything is signed.
 */
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Wallet } from "ethers";
import type { McpConfig } from "../config.js";
import { scrubCredentials, type HttpClient } from "../http-client.js";
import { readWalletKey, NodeToolError } from "./nodes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const IDEM_RE = /^[A-Za-z0-9_-]{8,120}$/;
const MUSD_RE = /^[1-9][0-9]{0,15}$/;

interface Money { musd: string; usd: string }

/** Must match payoutWalletMessage in packages/dashboard/src/routes/v1/credits.ts. */
export function payoutWalletMessage(i: { userId: string; wallet: string; address: string; chain: string; nonce: string }): string {
  return [
    "DominusNode payout wallet", "Action: payout_wallet_set", `User: ${i.userId}`, `Account wallet: ${i.wallet}`,
    `Payout address: ${i.address}`, `Chain: ${i.chain}`, `Nonce: ${i.nonce}`,
  ].join("\n");
}

/** Must match withdrawMessage in packages/dashboard/src/routes/v1/credits.ts. */
export function withdrawMessage(i: { userId: string; wallet: string; amountMusd: string; idempotencyKey: string; nonce: string }): string {
  return [
    "DominusNode withdrawal", "Action: withdraw", `User: ${i.userId}`, `Account wallet: ${i.wallet}`,
    `Amount (µUSD): ${i.amountMusd}`, `Idempotency key: ${i.idempotencyKey}`, `Nonce: ${i.nonce}`,
  ].join("\n");
}

/** Must match convertMessage in packages/dashboard/src/routes/v1/credits.ts. */
export function convertMessage(i: { userId: string; wallet: string; amountMusd: string; idempotencyKey: string; nonce: string }): string {
  return [
    "DominusNode credit conversion", "Action: convert", `User: ${i.userId}`, `Account wallet: ${i.wallet}`,
    `Amount (µUSD): ${i.amountMusd}`, `Idempotency key: ${i.idempotencyKey}`, `Nonce: ${i.nonce}`,
  ].join("\n");
}

/** The user id line is server-assigned; extract and validate it, everything else is rebuilt locally. */
function userIdFrom(message: string): string {
  const m = /\nUser: ([0-9a-f-]{36})\n/i.exec(message);
  if (!m || !UUID_RE.test(m[1])) throw new NodeToolError("server challenge message is malformed");
  return m[1];
}

function usd(m: Money | undefined): string {
  return m && typeof m.usd === "string" ? `$${m.usd}` : "?";
}

function errorResult(err: unknown, idempotencyKey?: string) {
  const retry = idempotencyKey
    ? `\nIdempotency key: ${idempotencyKey}. To retry safely, call again with idempotency_key="${idempotencyKey}" ` +
      `(same amount): the server applies it at most once.`
    : "";
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${scrubCredentials(err instanceof Error ? err.message : String(err))}${retry}` }],
  };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function linkedWallet(config: McpConfig): Wallet {
  if (!config.walletKeyFile) {
    throw new NodeToolError(
      "DOMINUSNODE_WALLET_KEY_FILE is not set. Point it at a chmod-600 file holding the private key of the wallet linked to this account, then restart the MCP server.",
    );
  }
  return new Wallet(readWalletKey(config.walletKeyFile));
}

const amountArg = z.string().regex(MUSD_RE).describe("Amount in integer µUSD as a string (1 USD = 1000000)");

export function registerCreditsTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  const bearer = () => {
    if (!config.apiKey) throw new NodeToolError("DOMINUSNODE_API_KEY is required for earnings tools");
    return config.apiKey;
  };

  server.tool(
    "dominusnode_credits_balance",
    "Show your node earnings (GET /v1/credits): pending (in maturity hold) and available credit, frozen flag, tier and hold days, " +
      "daily withdraw limit, tax form status, year-to-date paid, and whether on-chain payouts are enabled.",
    {},
    async () => {
      try {
        const c = await httpClient.request<{
          pending: Money; available: Money; frozen: boolean; autoConvertPct: number;
          tier: { name: string; holdDays: number; dailyWithdrawLimit: Money };
          taxFormStatus: string; ytdPaid: Money; payoutsEnabled: boolean; minWithdraw: Money;
        }>({ method: "GET", path: "/v1/credits", bearer: bearer() });
        return text([
          `Node earnings`,
          `  Pending (maturing): ${usd(c.pending)}`,
          `  Available: ${usd(c.available)}`,
          `  Frozen: ${c.frozen ? "YES (contact support)" : "no"}`,
          `  Tier: ${c.tier?.name ?? "?"} (hold ${c.tier?.holdDays ?? "?"} days, withdraw limit ${usd(c.tier?.dailyWithdrawLimit)}/day)`,
          `  Tax form: ${c.taxFormStatus}, paid this year: ${usd(c.ytdPaid)}`,
          `  Payouts: ${c.payoutsEnabled ? `enabled (min ${usd(c.minWithdraw)})` : "disabled; use dominusnode_credits_convert to spend credit as proxy balance"}`,
        ].join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_credits_transactions",
    "List your node earnings ledger (GET /v1/credits/transactions), newest first: earn, mature, clawback, convert, withdraw, withdraw_reversal.",
    {
      limit: z.number().int().min(1).max(200).default(50).describe("Max entries"),
      cursor: z.string().regex(/^[1-9][0-9]{0,18}$/).optional().describe("nextCursor from the previous page"),
      type: z.enum(["earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal"]).optional().describe("Filter by type"),
    },
    async (args) => {
      try {
        const q = new URLSearchParams({ limit: String(args.limit) });
        if (args.cursor) q.set("cursor", args.cursor);
        if (args.type) q.set("type", args.type);
        const r = await httpClient.request<{ transactions: Array<{ id: string; type: string; amount: Money; reference: string | null; createdAt: string }>; nextCursor: string | null }>(
          { method: "GET", path: `/v1/credits/transactions?${q.toString()}`, bearer: bearer() },
        );
        const tx = r.transactions ?? [];
        if (!tx.length) return text("No earnings transactions.");
        const lines = tx.map((t) => `${t.createdAt} #${t.id} ${t.type} ${usd(t.amount)}${t.reference ? ` ref=${t.reference}` : ""}`);
        if (r.nextCursor) lines.push(``, `More: cursor=${r.nextCursor}`);
        return text(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_credits_convert",
    "Convert available node credit into your own requester (proxy) wallet balance (POST /v1/credits/convert). Whole cents only; " +
      "the sub-cent remainder stays in credits. Credits never move to another user. Needs a fresh signature from the linked wallet " +
      "key in DOMINUSNODE_WALLET_KEY_FILE. Idempotent per key: the key is shown in the " +
      "result and in any error; on a timeout or error, retry with the same idempotency_key and amount so it is applied at most once.",
    {
      amount_musd: amountArg,
      idempotency_key: z.string().regex(IDEM_RE).optional().describe("Optional idempotency key (8-120 [A-Za-z0-9_-]); generated if omitted. Reuse the key from a failed call to retry safely"),
    },
    async (args) => {
      const key = args.idempotency_key ?? `mcp-conv-${randomBytes(12).toString("hex")}`;
      try {
        const n = BigInt(args.amount_musd);
        if (n < 10_000n || n > 10_000_000_000n) throw new NodeToolError("amount_musd must be between 10000 (1 cent) and 10000000000 ($10,000)");
        const signer = linkedWallet(config);
        const ch = await httpClient.request<{ nonce: string; message: string }>({
          method: "POST", path: "/v1/credits/convert/challenge", body: { amountMusd: args.amount_musd },
          headers: { "Idempotency-Key": key }, bearer: bearer(),
        });
        if (typeof ch.nonce !== "string" || !HEX64.test(ch.nonce) || typeof ch.message !== "string") throw new NodeToolError("invalid challenge");
        const expected = convertMessage({
          userId: userIdFrom(ch.message), wallet: signer.address.toLowerCase(), amountMusd: args.amount_musd, idempotencyKey: key, nonce: ch.nonce,
        });
        if (ch.message !== expected) throw new NodeToolError("server challenge does not match the requested conversion; refusing to sign");
        const r = await httpClient.request<{ converted: Money; convertedCents: number; duplicate: boolean }>({
          method: "POST", path: "/v1/credits/convert",
          body: { amountMusd: args.amount_musd, nonce: ch.nonce, signature: await signer.signMessage(expected) },
          headers: { "Idempotency-Key": key }, bearer: bearer(),
        });
        return text(`${r.duplicate ? "Already converted" : "Converted"} ${usd(r.converted)} to your wallet (idempotency key ${key}).`);
      } catch (err) {
        return errorResult(err, key);
      }
    },
  );

  server.tool(
    "dominusnode_payout_wallet_get",
    "Show your registered USDC payout wallet on Base (GET /v1/payout-wallet), including any 72h change cooldown.",
    {},
    async () => {
      try {
        const r = await httpClient.request<{ payoutWallet: { address: string; chain: string; status: string; activeFrom: string } | null }>(
          { method: "GET", path: "/v1/payout-wallet", bearer: bearer() },
        );
        const w = r.payoutWallet;
        if (!w) return text("No payout wallet registered. Use dominusnode_payout_wallet_set.");
        return text(`Payout wallet: ${w.address} on ${w.chain} [${w.status}]${w.status === "pending" ? ` - active from ${w.activeFrom}` : ""}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_payout_wallet_set",
    "Register or change your USDC payout address on Base (chain \"base\", or \"base-sepolia\" on testnet deployments; " +
      "the server decides which chain is valid). Signs a server challenge with the linked wallet key from " +
      "DOMINUSNODE_WALLET_KEY_FILE. A change also needs the CURRENT payout wallet's signature (key file in " +
      "DOMINUSNODE_PAYOUT_WALLET_KEY_FILE, unless it is the linked wallet) and starts a 72h cooldown during which nothing is paid out. " +
      "Keys are never accepted as arguments.",
    {
      address: z.string().regex(ADDRESS_RE).describe("New payout address (0x + 40 hex)"),
      chain: z.enum(["base", "base-sepolia"]).default("base").describe("Payout chain: base (mainnet) or base-sepolia (testnet); the server rejects a chain it does not use"),
      confirm: z.literal(true).describe("Must be true: payouts will go to this address"),
    },
    async (args) => {
      try {
        const signer = linkedWallet(config);
        const address = args.address.toLowerCase();
        const chain = args.chain ?? "base";
        if (chain !== "base" && chain !== "base-sepolia") throw new NodeToolError("chain must be base or base-sepolia");
        const ch = await httpClient.request<{ nonce: string; message: string; signer: string; oldWalletSignatureRequired: boolean; oldWalletAddress: string | null }>(
          { method: "POST", path: "/v1/payout-wallet/challenge", body: { address, chain }, bearer: bearer() },
        );
        if (typeof ch.nonce !== "string" || !HEX64.test(ch.nonce) || typeof ch.message !== "string") throw new NodeToolError("invalid challenge");
        const expected = payoutWalletMessage({ userId: userIdFrom(ch.message), wallet: signer.address.toLowerCase(), address, chain, nonce: ch.nonce });
        if (ch.message !== expected) {
          throw new NodeToolError("server challenge does not match the locally built message (is DOMINUSNODE_WALLET_KEY_FILE the wallet linked to this account?)");
        }
        const body: Record<string, unknown> = { address, chain, nonce: ch.nonce, signature: await signer.signMessage(expected) };
        if (ch.oldWalletSignatureRequired) {
          if (!config.payoutWalletKeyFile) {
            throw new NodeToolError("changing the payout wallet needs the current payout wallet's signature: set DOMINUSNODE_PAYOUT_WALLET_KEY_FILE (chmod 600) and restart");
          }
          const old = new Wallet(readWalletKey(config.payoutWalletKeyFile));
          if (ch.oldWalletAddress && old.address.toLowerCase() !== ch.oldWalletAddress.toLowerCase()) {
            throw new NodeToolError("DOMINUSNODE_PAYOUT_WALLET_KEY_FILE is not the current payout wallet");
          }
          body["oldWalletSignature"] = await old.signMessage(expected);
        }
        const r = await httpClient.request<{ payoutWallet: { address: string; status: string; activeFrom: string }; changed: boolean; cooldownHours: number }>(
          { method: "PUT", path: "/v1/payout-wallet", body, bearer: bearer() },
        );
        return text(r.changed
          ? `Payout wallet change accepted: ${r.payoutWallet.address} becomes active at ${r.payoutWallet.activeFrom} (${r.cooldownHours}h cooldown). Unsent payouts to the old wallet were returned to available credit.`
          : `Payout wallet registered: ${r.payoutWallet.address} (${r.payoutWallet.status}).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_credits_withdraw",
    "Withdraw available node credit as USDC on Base to your payout wallet (POST /v1/credits/withdraw). Minimum $1, tier daily limit, " +
      "fresh signature from the linked wallet key in DOMINUSNODE_WALLET_KEY_FILE. Returns 503 PAYOUTS_DISABLED while payouts are off. " +
      "Idempotent per key: the key is shown in the result and in any error; on a timeout or error, retry with the same " +
      "idempotency_key and amount so at most one payout is created.",
    {
      amount_musd: amountArg,
      idempotency_key: z.string().regex(IDEM_RE).optional().describe("Optional idempotency key; reuse it to retry safely. Generated if omitted"),
      confirm: z.literal(true).describe("Must be true to request the withdrawal"),
    },
    async (args) => {
      const key = args.idempotency_key ?? `mcp-wd-${randomBytes(12).toString("hex")}`;
      try {
        if (BigInt(args.amount_musd) < 1_000_000n) throw new NodeToolError("minimum withdrawal is $1 (amount_musd >= 1000000)");
        const signer = linkedWallet(config);
        const ch = await httpClient.request<{ nonce: string; message: string }>({
          method: "POST", path: "/v1/credits/withdraw/challenge", body: { amountMusd: args.amount_musd, idempotencyKey: key }, bearer: bearer(),
        });
        if (typeof ch.nonce !== "string" || !HEX64.test(ch.nonce) || typeof ch.message !== "string") throw new NodeToolError("invalid challenge");
        const expected = withdrawMessage({
          userId: userIdFrom(ch.message), wallet: signer.address.toLowerCase(), amountMusd: args.amount_musd, idempotencyKey: key, nonce: ch.nonce,
        });
        if (ch.message !== expected) throw new NodeToolError("server challenge does not match the requested withdrawal; refusing to sign");
        const r = await httpClient.request<{ payout: { id: string; amount: Money; status: string }; duplicate: boolean }>({
          method: "POST", path: "/v1/credits/withdraw",
          body: { amountMusd: args.amount_musd, idempotencyKey: key, nonce: ch.nonce, signature: await signer.signMessage(expected) },
          bearer: bearer(),
        });
        return text(`${r.duplicate ? "Existing" : "New"} payout ${r.payout.id}: ${usd(r.payout.amount)} [${r.payout.status}] (idempotency key ${key}). Track it with dominusnode_payouts_list.`);
      } catch (err) {
        return errorResult(err, key);
      }
    },
  );

  server.tool(
    "dominusnode_payouts_list",
    "List your on-chain payouts (GET /v1/payouts) with status and transaction hash.",
    {
      limit: z.number().int().min(1).max(200).default(50).describe("Max payouts"),
      offset: z.number().int().min(0).max(1_000_000).default(0).describe("Pagination offset"),
    },
    async (args) => {
      try {
        const r = await httpClient.request<{ payouts: Array<{ id: string; amount: Money; trigger: string; status: string; txHash: string | null; address: string | null; createdAt: string }> }>(
          { method: "GET", path: `/v1/payouts?limit=${args.limit}&offset=${args.offset}`, bearer: bearer() },
        );
        const p = r.payouts ?? [];
        if (!p.length) return text("No payouts yet.");
        return text(p.map((x) => `${x.createdAt} ${x.id} ${usd(x.amount)} ${x.trigger} [${x.status}] to=${x.address ?? "?"} tx=${x.txHash ?? "-"}`).join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_update_caps",
    "Lower the caps of one of your relay nodes (PATCH /v1/nodes/:id). Caps can only be lowered, never above the policy defaults; " +
      "the gateway applies them when the node next connects.",
    {
      node_id: z.string().regex(UUID_RE).describe("Node UUID from dominusnode_node_list"),
      max_streams: z.number().int().min(1).max(1024).optional().describe("Concurrent stream cap"),
      gb_per_day: z.number().int().min(1).max(10000).optional().describe("Daily GB cap"),
      req_per_sec: z.number().int().min(1).max(100000).optional().describe("New streams per second cap"),
    },
    async (args) => {
      try {
        const body: Record<string, number> = {};
        if (args.max_streams !== undefined) body["maxStreams"] = args.max_streams;
        if (args.gb_per_day !== undefined) body["gbPerDay"] = args.gb_per_day;
        if (args.req_per_sec !== undefined) body["reqPerSec"] = args.req_per_sec;
        if (!Object.keys(body).length) throw new NodeToolError("give at least one of max_streams, gb_per_day, req_per_sec");
        const r = await httpClient.request<{ id: string; effective: { maxStreams: number; gbPerDay: number; reqPerSec: number } }>({
          method: "PATCH", path: `/v1/nodes/${encodeURIComponent(args.node_id)}`, body, bearer: bearer(),
        });
        return text(`Node ${r.id} caps: streams=${r.effective.maxStreams} gb/day=${r.effective.gbPerDay} req/s=${r.effective.reqPerSec} (applied on next tunnel connect).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_session_report",
    "Report a burned/blocked exit for one of your own relay sessions (POST /v1/sessions/:id/report). Lowers that node's reputation; " +
      "at most 5 reports per node per day, one per session.",
    {
      session_id: z.string().regex(UUID_RE).describe("Your session UUID (dominusnode_get_active_sessions)"),
      reason: z.enum(["blocked", "captcha", "rate_limited", "slow", "bad_content", "other"]).describe("What went wrong"),
    },
    async (args) => {
      try {
        const r = await httpClient.request<{ reportId: string; reportsToday: number; limitPerDay: number }>({
          method: "POST", path: `/v1/sessions/${encodeURIComponent(args.session_id)}/report`, body: { reason: args.reason }, bearer: bearer(),
        });
        return text(`Report ${r.reportId} recorded (${r.reportsToday}/${r.limitPerDay} for this node today).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
