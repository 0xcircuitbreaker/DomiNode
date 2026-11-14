import { Job, JOB_LOCK_KEYS, type JobLogger, type LockPool } from "./runner.js";

/**
 * Payout job (DESIGN.md §15, ECONOMICS.md §3): daily auto-queue of matured
 * credit ≥ $1, then USDC push on Base for every pending payout.
 *
 * Money invariants:
 * - Runs only when PAYOUTS_ENABLED=true.
 * - SDN list missing/unreadable → nothing is paid this run.
 * - Destination screened before EVERY payout; a hit blocks the wallet and freezes the account.
 * - A payout id is claimed (pending → submitted, CAS) before send, so it is broadcast at most once.
 * - The signed tx hash and nonce are recorded BEFORE broadcast; if that write fails
 *   nothing is broadcast and the payout returns to pending.
 * - Only a proven non-broadcast returns a payout to pending; ambiguous send errors stay
 *   'submitted' for admin reconciliation (never re-sent automatically). Stranded
 *   rows (no hash) are logged every run; admins resolve them with
 *   POST /api/admin/network/payouts/:id/confirm | /fail.
 * - The "payouts" kill switch is re-checked before every queue and every claim.
 * - Reverted/dropped tx → markFailed then markReversed, which re-credits available.
 */

export type PayoutChain = "base" | "base-sepolia";

export interface SendRequest {
  payoutId: string;
  to: string;
  amountMusd: bigint;
  chain: PayoutChain;
  /**
   * Called with the signed tx hash and nonce BEFORE broadcast. The sender must
   * not broadcast if it throws or returns false (and must then throw
   * PayoutNotBroadcastError), so a hash is always persisted before the
   * transfer can reach the chain.
   */
  beforeBroadcast?: (txHash: string, nonce: number) => Promise<boolean>;
}

export type ReceiptStatus = "confirmed" | "reverted" | "dropped" | "pending";

export interface PayoutSender {
  /** Broadcast a USDC transfer. Must be idempotent per payoutId within the process. */
  send(req: SendRequest): Promise<{ txHash: string }>;
  /** timeoutMs overrides the sender's default wait (reconciliation uses a short one). */
  waitForReceipt(txHash: string, timeoutMs?: number, nonce?: number): Promise<ReceiptStatus>;
  /**
   * Optional treasury check before the send loop: whether the hot wallet has
   * gas, and how much USDC (µUSD) it holds. A run with no gas sends nothing.
   */
  preflight?(chain: PayoutChain): Promise<{ gasOk: boolean; usdcMusd: bigint }>;
}

/**
 * Thrown by a sender only when it is CERTAIN nothing reached the network.
 * stopRun: the cause affects every later payout too (hot wallet out of gas,
 * nonce trouble), so the run stops instead of claiming and failing each one.
 */
export class PayoutNotBroadcastError extends Error {
  constructor(message: string, readonly stopRun = false) {
    super(message);
    this.name = "PayoutNotBroadcastError";
  }
}

/** Receipt wait during reconciliation of earlier broadcasts (checked in parallel). */
export const RECONCILE_RECEIPT_TIMEOUT_MS = 5_000;
const RECONCILE_CONCURRENCY = 10;

/** Broadcast outcome unknown; the signed tx hash is known and must be tracked. */
export class PayoutBroadcastUncertainError extends Error {
  constructor(readonly txHash: string, message: string) {
    super(message);
    this.name = "PayoutBroadcastUncertainError";
  }
}

export interface DuePayout {
  id: string;
  userId: string;
  payoutWalletId: string;
  address: string;
  chain: PayoutChain;
  amountMusd: bigint;
}

export interface PayoutDeps {
  enabled(): boolean;
  /**
   * Admin "payouts" kill switch. While true the run only reconciles payouts
   * already broadcast (receipt checks, confirm / reverse); it queues, claims
   * and sends nothing new.
   */
  paused?(): boolean;
  loadSdn(): Promise<Set<string>>;
  /** remainingDailyMusd: tier daily_withdraw_limit_musd minus today's non-failed payouts (same rule as requestWithdraw). */
  listAutoCandidates(): Promise<{ userId: string; availableMusd: bigint; remainingDailyMusd: bigint }[]>;
  requestWithdraw(req: { userId: string; amountMusd: bigint; idempotencyKey: string; trigger: "auto" }): Promise<unknown>;
  listDue(): Promise<DuePayout[]>;
  listSubmitted(): Promise<{ id: string; txHash: string; nonce?: number }[]>;
  /** 'submitted' payouts with no tx hash past the stranded age (admin must resolve). */
  listStranded?(): Promise<{ id: string }[]>;
  claim(payoutId: string): Promise<boolean>;
  recordTx(payoutId: string, txHash: string, nonce?: number): Promise<boolean>;
  releaseUnbroadcast(payoutId: string): Promise<boolean>;
  markConfirmed(payoutId: string, txHash: string): Promise<unknown>;
  markFailed(payoutId: string, evidence: { txHash: string; outcome: "dropped" | "reverted" }): Promise<unknown>;
  markReversed(payoutId: string, reason: string): Promise<unknown>;
  blockWallet(payoutWalletId: string, userId: string): Promise<void>;
  sender: PayoutSender;
  now?: () => Date;
  /** Global treasury cap per run (µUSD); 0n/undefined = no cap. */
  runCapMusd?: bigint;
  logger?: JobLogger;
}

export interface PayoutRunResult {
  skipped?: "disabled" | "paused" | "sdn_unavailable";
  queued: number;
  sent: number;
  confirmed: number;
  reversed: number;
  sanctioned: number;
  ambiguous: number;
  released: number;
  /** Submitted payouts with no recorded tx hash (need admin confirm/fail). */
  stranded: number;
  /** Candidates whose daily limit was already used up today (nothing to queue). */
  autoSkipped: number;
  /** Candidates whose auto request was refused (logged at warn; summary at error). */
  autoFailed: number;
  paidMusd: bigint;
}

const MAX_AUTO_MUSD = 100_000_000_000n;
/** Mirrors payout-repo MIN_WITHDRAW_MUSD ($1): requestWithdraw refuses anything smaller. */
const MIN_AUTO_MUSD = 1_000_000n;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function settleReceipt(deps: PayoutDeps, id: string, txHash: string, out: PayoutRunResult, timeoutMs?: number, nonce?: number): Promise<void> {
  const st = timeoutMs === undefined && nonce === undefined
    ? await deps.sender.waitForReceipt(txHash)
    : await deps.sender.waitForReceipt(txHash, timeoutMs, nonce);
  if (st === "confirmed") {
    await deps.markConfirmed(id, txHash);
    out.confirmed++;
  } else if (st === "reverted" || st === "dropped") {
    await deps.markFailed(id, { txHash, outcome: st });
    await deps.markReversed(id, `tx ${st}`); // re-credits available
    out.reversed++;
  }
  // pending: reconciled on a later run via listSubmitted
}

async function reconcileSubmitted(deps: PayoutDeps, out: PayoutRunResult): Promise<void> {
  const submitted = await deps.listSubmitted();
  for (let i = 0; i < submitted.length; i += RECONCILE_CONCURRENCY) {
    await Promise.all(submitted.slice(i, i + RECONCILE_CONCURRENCY).map(async (s) => {
      try {
        await settleReceipt(deps, s.id, s.txHash, out, RECONCILE_RECEIPT_TIMEOUT_MS, s.nonce);
      } catch (err) {
        deps.logger?.warn("payout reconcile failed", { payoutId: s.id, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      }
    }));
  }
  if (deps.listStranded) {
    try {
      const stranded = await deps.listStranded();
      out.stranded = stranded.length;
      if (stranded.length > 0) {
        deps.logger?.error("payouts stranded in submitted with no tx hash: confirm or fail them via the admin API", {
          count: stranded.length, payoutIds: stranded.slice(0, 10).map((x) => x.id),
        });
      }
    } catch (err) {
      deps.logger?.warn("stranded payout check failed", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    }
  }
}

export async function runOnce(deps: PayoutDeps): Promise<PayoutRunResult> {
  const out: PayoutRunResult = { queued: 0, sent: 0, confirmed: 0, reversed: 0, sanctioned: 0, ambiguous: 0, released: 0, stranded: 0, autoSkipped: 0, autoFailed: 0, paidMusd: 0n };
  if (!deps.enabled()) return { ...out, skipped: "disabled" };

  // Kill switch: keep settling broadcasts already on chain (no SDN needed:
  // nothing new is sent), stop before any new queueing or broadcast.
  if (deps.paused?.()) {
    await reconcileSubmitted(deps, out);
    return { ...out, skipped: "paused" };
  }

  let sdn: Set<string>;
  try {
    sdn = await deps.loadSdn();
  } catch (err) {
    deps.logger?.error("payout run refused: SDN list unavailable", { error: err instanceof Error ? err.message : "unknown" });
    return { ...out, skipped: "sdn_unavailable" };
  }

  // 1. Reconcile earlier broadcasts: short timeout, in parallel batches, so a
  // backlog of stranded payouts cannot block the run for minutes each.
  await reconcileSubmitted(deps, out);

  // 2. Daily auto-queue (idempotent per user per UTC day).
  const key = `auto-${dayKey((deps.now ?? (() => new Date()))())}`;
  // The kill switch is re-read before every queue and every claim, so engaging
  // it mid-run stops new work at once (ADMIN_API.md §17).
  const pausedNow = (): boolean => {
    try {
      return deps.paused?.() === true;
    } catch {
      return true; // unreadable switch state fails closed
    }
  };
  for (const c of await deps.listAutoCandidates()) {
    if (pausedNow()) {
      deps.logger?.warn("payout run paused mid-run by kill switch (auto-queue)", { queued: out.queued });
      return { ...out, skipped: "paused" };
    }
    // Cap at the tier's remaining daily limit: asking for the whole balance made
    // requestWithdraw refuse every day for anyone whose balance exceeds the limit.
    let amount = c.availableMusd;
    if (c.remainingDailyMusd < amount) amount = c.remainingDailyMusd;
    if (MAX_AUTO_MUSD < amount) amount = MAX_AUTO_MUSD;
    if (amount < MIN_AUTO_MUSD) {
      out.autoSkipped++;
      continue; // daily limit already used up today
    }
    try {
      await deps.requestWithdraw({ userId: c.userId, amountMusd: amount, idempotencyKey: key, trigger: "auto" });
      out.queued++;
    } catch (err) {
      out.autoFailed++;
      deps.logger?.warn("auto payout not queued", { userId: c.userId, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    }
  }
  if (out.autoFailed > 0) {
    deps.logger?.error("auto payouts refused for some owners", { failed: out.autoFailed, queued: out.queued });
  }

  // 3. Send.
  const cap = deps.runCapMusd && deps.runCapMusd > 0n ? deps.runCapMusd : null;
  const due = await deps.listDue();
  // Treasury preflight (per chain): no gas -> send nothing; USDC caps the run.
  const treasury = new Map<PayoutChain, { gasOk: boolean; usdcMusd: bigint } | null>();
  for (const p of due) {
    if (treasury.has(p.chain) || !deps.sender.preflight) continue;
    try {
      treasury.set(p.chain, await deps.sender.preflight(p.chain));
    } catch (err) {
      treasury.set(p.chain, null);
      deps.logger?.warn("payout treasury preflight failed", { chain: p.chain, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    }
  }
  const spent = new Map<PayoutChain, bigint>();
  for (const p of due) {
    const t = treasury.get(p.chain);
    if (t && !t.gasOk) {
      deps.logger?.error("payout run stopped: hot wallet has no gas", { chain: p.chain });
      break;
    }
    if (t && (spent.get(p.chain) ?? 0n) + p.amountMusd > t.usdcMusd) {
      deps.logger?.error("payout run stopped: hot wallet USDC balance too low", { chain: p.chain, usdcMusd: t.usdcMusd.toString() });
      break;
    }
    const to = p.address.toLowerCase();
    if (sdn.has(to)) {
      await deps.blockWallet(p.payoutWalletId, p.userId);
      out.sanctioned++;
      deps.logger?.warn("payout refused: SDN match, wallet blocked and account frozen", { payoutId: p.id });
      continue;
    }
    if (cap && out.paidMusd + p.amountMusd > cap) {
      deps.logger?.warn("payout run treasury cap reached", { cap: cap.toString() });
      break;
    }
    if (pausedNow()) {
      deps.logger?.warn("payout run paused mid-run by kill switch (send)", { sent: out.sent });
      return { ...out, skipped: "paused" };
    }
    if (!(await deps.claim(p.id))) continue; // someone else has it

    let txHash: string;
    let recorded = false;
    try {
      ({ txHash } = await deps.sender.send({
        payoutId: p.id, to, amountMusd: p.amountMusd, chain: p.chain,
        // Persist hash + nonce before broadcast: a crash or DB error can then
        // never leave an on-chain transfer with no recorded hash.
        beforeBroadcast: async (hash, nonce) => {
          recorded = await deps.recordTx(p.id, hash, nonce);
          return recorded;
        },
      }));
    } catch (err) {
      if (err instanceof PayoutNotBroadcastError) {
        await deps.releaseUnbroadcast(p.id);
        out.released++;
        if (err.stopRun) {
          deps.logger?.error("payout run stopped: broadcast rejected", { payoutId: p.id, error: err.message.slice(0, 120) });
          break;
        }
      } else {
        out.ambiguous++;
        if (err instanceof PayoutBroadcastUncertainError) await deps.recordTx(p.id, err.txHash).catch(() => false);
        deps.logger?.error("payout send ambiguous: left submitted for admin review", { payoutId: p.id, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      }
      continue;
    }
    if (!recorded) await deps.recordTx(p.id, txHash); // sender without the beforeBroadcast hook
    out.sent++;
    out.paidMusd += p.amountMusd;
    spent.set(p.chain, (spent.get(p.chain) ?? 0n) + p.amountMusd);
    try {
      await settleReceipt(deps, p.id, txHash, out);
    } catch (err) {
      deps.logger?.warn("payout receipt check failed", { payoutId: p.id, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    }
  }
  return out;
}

export function start(o: { deps: PayoutDeps; pool: LockPool; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "payouts", intervalMs: o.intervalMs ?? 86_400_000, lockKey: JOB_LOCK_KEYS.payouts, pool: o.pool,
    logger: o.logger, run: () => runOnce({ ...o.deps, logger: o.deps.logger ?? o.logger }), initialDelayMs: 120_000,
  });
  job.start();
  return job;
}

export async function stop(job: Job | null): Promise<void> {
  await job?.stop();
}
