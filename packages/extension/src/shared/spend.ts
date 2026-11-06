/**
 * Per-run spend tracking from wallet balance samples.
 *
 * spent = baseline - current. A top-up (balance rises) moves the baseline up by the
 * top-up amount so it is not counted as negative spend.
 */
export interface RunState {
  /** Epoch ms when the run started. */
  startedAt: number;
  /** Balance at run start, in cents (null until the first sample). */
  baselineCents: number | null;
  /** Last observed balance, in cents. */
  lastBalanceCents: number | null;
  /** Cents spent this run. */
  spentCents: number;
  /** True once the spend cap or a zero balance stopped proxying. */
  blocked: boolean;
  blockReason: string | null;
  lastSampleAt: number | null;
  lastError: string | null;
}

export function newRun(now = Date.now()): RunState {
  return {
    startedAt: now,
    baselineCents: null,
    lastBalanceCents: null,
    spentCents: 0,
    blocked: false,
    blockReason: null,
    lastSampleAt: null,
    lastError: null,
  };
}

/** Apply a balance sample. Pure: returns the new run state. */
export function applyBalanceSample(run: RunState, balanceCents: number, capCents: number | null, now = Date.now()): RunState {
  const r: RunState = { ...run, lastSampleAt: now, lastError: null };
  if (r.baselineCents === null || r.lastBalanceCents === null) {
    r.baselineCents = balanceCents;
  } else if (balanceCents > r.lastBalanceCents) {
    // Top-up: shift the baseline so it does not count as negative spend.
    r.baselineCents += balanceCents - r.lastBalanceCents;
  }
  r.lastBalanceCents = balanceCents;
  r.spentCents = Math.max(0, r.baselineCents - balanceCents);
  const decision = spendDecision(r.spentCents, balanceCents, capCents);
  if (decision) {
    r.blocked = true;
    r.blockReason = decision;
  }
  return r;
}

/** Returns a block reason when proxying must stop, else null. */
export function spendDecision(spentCents: number, balanceCents: number, capCents: number | null): string | null {
  if (capCents !== null && spentCents >= capCents) return `Spend cap reached (${spentCents}¢ of ${capCents}¢ this run)`;
  if (balanceCents <= 0) return "Wallet balance is zero";
  return null;
}
