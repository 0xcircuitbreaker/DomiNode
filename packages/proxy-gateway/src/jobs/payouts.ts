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
 * - Only a proven non-broadcast returns a payout to pending; ambiguous send errors stay
 *   'submitted' for admin reconciliation (never re-sent automatically).
 * - Reverted/dropped tx → markFailed then markReversed, which re-credits available.
 */

export type PayoutChain = "base" | "base-sepolia";

export interface SendRequest {
  payoutId: string;
  to: string;
  amountMusd: bigint;
  chain: PayoutChain;
}

export type ReceiptStatus = "confirmed" | "reverted" | "dropped" | "pending";

export interface PayoutSender {
  /** Broadcast a USDC transfer. Must be idempotent per payoutId within the process. */
  send(req: SendRequest): Promise<{ txHash: string }>;
  waitForReceipt(txHash: string): Promise<ReceiptStatus>;
}

/** Thrown by a sender only when it is CERTAIN nothing reached the network. */
export class PayoutNotBroadcastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutNotBroadcastError";
  }
}

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
  loadSdn(): Promise<Set<string>>;
  /** remainingDailyMusd: tier daily_withdraw_limit_musd minus today's non-failed payouts (same rule as requestWithdraw). */
  listAutoCandidates(): Promise<{ userId: string; availableMusd: bigint; remainingDailyMusd: bigint }[]>;
  requestWithdraw(req: { userId: string; amountMusd: bigint; idempotencyKey: string; trigger: "auto" }): Promise<unknown>;
  listDue(): Promise<DuePayout[]>;
  listSubmitted(): Promise<{ id: string; txHash: string }[]>;
  claim(payoutId: string): Promise<boolean>;
  recordTx(payoutId: string, txHash: string): Promise<boolean>;
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
  skipped?: "disabled" | "sdn_unavailable";
  queued: number;
  sent: number;
  confirmed: number;
  reversed: number;
  sanctioned: number;
  ambiguous: number;
  released: number;
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

async function settleReceipt(deps: PayoutDeps, id: string, txHash: string, out: PayoutRunResult): Promise<void> {
  const st = await deps.sender.waitForReceipt(txHash);
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

export async function runOnce(deps: PayoutDeps): Promise<PayoutRunResult> {
  const out: PayoutRunResult = { queued: 0, sent: 0, confirmed: 0, reversed: 0, sanctioned: 0, ambiguous: 0, released: 0, autoSkipped: 0, autoFailed: 0, paidMusd: 0n };
  if (!deps.enabled()) return { ...out, skipped: "disabled" };

  let sdn: Set<string>;
  try {
    sdn = await deps.loadSdn();
  } catch (err) {
    deps.logger?.error("payout run refused: SDN list unavailable", { error: err instanceof Error ? err.message : "unknown" });
    return { ...out, skipped: "sdn_unavailable" };
  }

  // 1. Reconcile earlier broadcasts.
  for (const s of await deps.listSubmitted()) {
    try {
      await settleReceipt(deps, s.id, s.txHash, out);
    } catch (err) {
      deps.logger?.warn("payout reconcile failed", { payoutId: s.id, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
    }
  }

  // 2. Daily auto-queue (idempotent per user per UTC day).
  const key = `auto-${dayKey((deps.now ?? (() => new Date()))())}`;
  for (const c of await deps.listAutoCandidates()) {
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
  for (const p of await deps.listDue()) {
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
    if (!(await deps.claim(p.id))) continue; // someone else has it

    let txHash: string;
    try {
      ({ txHash } = await deps.sender.send({ payoutId: p.id, to, amountMusd: p.amountMusd, chain: p.chain }));
    } catch (err) {
      if (err instanceof PayoutNotBroadcastError) {
        await deps.releaseUnbroadcast(p.id);
        out.released++;
      } else {
        out.ambiguous++;
        if (err instanceof PayoutBroadcastUncertainError) await deps.recordTx(p.id, err.txHash).catch(() => false);
        deps.logger?.error("payout send ambiguous: left submitted for admin review", { payoutId: p.id, error: err instanceof Error ? err.message.slice(0, 120) : "unknown" });
      }
      continue;
    }
    await deps.recordTx(p.id, txHash);
    out.sent++;
    out.paidMusd += p.amountMusd;
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
