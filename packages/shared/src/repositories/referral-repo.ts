import type { DbTxClient } from "../db.js";
import { query, queryOn, getPool } from "../db.js";
import { createLogger } from "../logger.js";
import type {
  ReferralCode,
  ReferralRedemption,
  AffiliateLink,
  AffiliateCommission,
  AffiliateStats,
  PromoCode,
  PromoRedemption,
  LoyaltyTier,
  LoyaltyReward,
  LoyaltyStatus,
} from "../types.js";

const log = createLogger("referral-repo");

const MAX_ACTIVE_CODES_PER_USER = 5;
const MAX_BALANCE_CENTS = 1_000_000;
// Default affiliate commission: 10% (1000 basis points)
const DEFAULT_COMMISSION_RATE = 1000;

// ─── Referral Codes ──────────────────────────────────────────────────

export async function createReferralCode(
  userId: string,
  codeHash: string,
  codePrefix: string,
  options?: { maxUses?: number; creditCents?: number; expiresAt?: Date },
): Promise<ReferralCode> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check active code count (FOR UPDATE to prevent TOCTOU)
    const countResult = await client.query(
      "SELECT COUNT(*) AS cnt FROM referral_codes WHERE user_id = $1 AND active = true FOR UPDATE",
      [userId],
    );
    const count = parseInt((countResult.rows[0] as { cnt: string }).cnt, 10);
    if (count >= MAX_ACTIVE_CODES_PER_USER) {
      await client.query("ROLLBACK");
      throw new Error(`Maximum ${MAX_ACTIVE_CODES_PER_USER} active referral codes allowed`);
    }

    const maxUses = options?.maxUses ?? 0; // 0 = unlimited
    const creditCents = options?.creditCents ?? 100; // $1.00 default
    // Validate creditCents range at repo level (defense-in-depth)
    if (!Number.isFinite(creditCents) || creditCents < 0 || creditCents > 100000) {
      await client.query("ROLLBACK");
      throw new Error("creditCents must be between 0 and 100000");
    }
    const expiresAt = options?.expiresAt ?? null;

    // Do not return code_hash from RETURNING — hash must not leave DB boundary
    const result = await client.query(
      `INSERT INTO referral_codes (user_id, code_hash, code_prefix, max_uses, credit_cents, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, code_prefix, max_uses, uses, credit_cents, active, expires_at, created_at`,
      [userId, codeHash, codePrefix, maxUses, creditCents, expiresAt],
    );

    await client.query("COMMIT");
    return result.rows[0] as ReferralCode;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function findReferralCodeByHash(codeHash: string): Promise<ReferralCode | null> {
  const result = await query<ReferralCode>(
    `SELECT id, user_id, code_hash, code_prefix, max_uses, uses, credit_cents, active, expires_at, created_at
     FROM referral_codes
     WHERE code_hash = $1 AND active = true
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses = 0 OR uses < max_uses)`,
    [codeHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Admin switch for referral redemption (referral_settings.redemption_enabled).
 * Fails closed: a missing row or a lookup error reads as disabled.
 */
export async function isRedemptionEnabled(client?: Pick<DbTxClient, "query">): Promise<boolean> {
  try {
    const sql = "SELECT redemption_enabled FROM referral_settings WHERE id = 1";
    const r = client ? await client.query<{ redemption_enabled: boolean }>(sql) : await query<{ redemption_enabled: boolean }>(sql);
    return r.rows[0]?.redemption_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Record a referral (redemption row + affiliate link). Disabled unless an
 * admin turns referral_settings.redemption_enabled on, and even then it credits
 * no signup bonus to either side. It does create the affiliate link, so the
 * referrer later earns recordAffiliateCommission on the referee's paid top-ups
 * (a share of real money paid in, not minted credit). The old $1 + $1 balance bonus minted spendable credit per sybil
 * signup with none of the starter-credit controls. Free credit for a new
 * principal comes only from the starter-credit grant ledger (caps, budget,
 * funding check, expiry, seed-only routing, starter_musd stamping), which the
 * sign-up path already applies. Returns null when disabled or the code is unusable.
 */
export async function redeemReferralCode(
  codeHash: string,
  refereeUserId: string,
): Promise<{ referralCode: ReferralCode; redemption: ReferralRedemption } | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await isRedemptionEnabled(client))) {
      await client.query("ROLLBACK");
      return null;
    }

    // Lock the referral code row
    const codeResult = await client.query(
      `SELECT id, user_id, code_hash, code_prefix, max_uses, uses, credit_cents, active, expires_at, created_at
       FROM referral_codes
       WHERE code_hash = $1 AND active = true
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (max_uses = 0 OR uses < max_uses)
       FOR UPDATE`,
      [codeHash],
    );
    const code = codeResult.rows[0] as ReferralCode | undefined;
    if (!code) {
      await client.query("ROLLBACK");
      return null;
    }

    // Prevent self-referral
    if (code.user_id === refereeUserId) {
      await client.query("ROLLBACK");
      throw new Error("Cannot use your own referral code");
    }

    // Check if referee already redeemed any code (UNIQUE on referee_id)
    const existingResult = await client.query(
      "SELECT 1 FROM referral_redemptions WHERE referee_id = $1",
      [refereeUserId],
    );
    if (existingResult.rows.length > 0) {
      await client.query("ROLLBACK");
      throw new Error("You have already used a referral code");
    }

    // Increment uses and capture updated count to avoid stale return value
    const updatedCode = await client.query<{ uses: number }>(
      "UPDATE referral_codes SET uses = uses + 1 WHERE id = $1 RETURNING uses",
      [code.id],
    );
    code.uses = updatedCode.rows[0]!.uses;

    // Create redemption record
    const redemptionResult = await client.query(
      `INSERT INTO referral_redemptions (referral_code_id, referrer_id, referee_id, credit_cents)
       VALUES ($1, $2, $3, $4)
       RETURNING id, referral_code_id, referrer_id, referee_id, credit_cents, created_at`,
      [code.id, code.user_id, refereeUserId, 0],
    );

    // Create affiliate link (lifetime relationship)
    await client.query(
      `INSERT INTO affiliate_links (referrer_id, referee_id)
       VALUES ($1, $2) ON CONFLICT (referee_id) DO NOTHING`,
      [code.user_id, refereeUserId],
    );

    await client.query("COMMIT");
    return {
      referralCode: code,
      redemption: redemptionResult.rows[0] as ReferralRedemption,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listReferralCodes(userId: string): Promise<Omit<ReferralCode, "code_hash">[]> {
  // Never return code_hash — SHA-256 of 30^8 space is brute-forceable
  const result = await query<Omit<ReferralCode, "code_hash">>(
    `SELECT id, user_id, code_prefix, max_uses, uses, credit_cents, active, expires_at, created_at
     FROM referral_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return result.rows;
}

export async function disableReferralCode(userId: string, codeId: string): Promise<boolean> {
  const result = await query(
    "UPDATE referral_codes SET active = false WHERE id = $1 AND user_id = $2 AND active = true",
    [codeId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getReferralStats(userId: string): Promise<{
  totalCodes: number;
  activeCodes: number;
  totalReferrals: number;
  totalCreditedCents: number;
}> {
  const codesResult = await query<{ total: string; active: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE active = true) AS active
     FROM referral_codes WHERE user_id = $1`,
    [userId],
  );
  const referralsResult = await query<{ cnt: string; total_credit: string }>(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(credit_cents), 0) AS total_credit
     FROM referral_redemptions WHERE referrer_id = $1`,
    [userId],
  );
  const row = codesResult.rows[0];
  const refRow = referralsResult.rows[0];
  return {
    totalCodes: parseInt(row?.total ?? "0", 10),
    activeCodes: parseInt(row?.active ?? "0", 10),
    totalReferrals: parseInt(refRow?.cnt ?? "0", 10),
    totalCreditedCents: parseInt(refRow?.total_credit ?? "0", 10),
  };
}

// ─── Affiliate ───────────────────────────────────────────────────────

export async function recordAffiliateCommission(
  refereeUserId: string,
  topupAmountCents: number,
  paymentId: string,
): Promise<void> {
  try {
    // NaN guard — NaN arithmetic silently produces NaN commissions
    if (!Number.isFinite(topupAmountCents) || topupAmountCents <= 0) {
      log.warn("recordAffiliateCommission: invalid topupAmountCents", { refereeUserId, topupAmountCents });
      return;
    }

    // Find the affiliate link for this referee
    const linkResult = await query<AffiliateLink>(
      "SELECT referrer_id FROM affiliate_links WHERE referee_id = $1 AND active = true",
      [refereeUserId],
    );
    if (linkResult.rows.length === 0) return; // No affiliate link

    const referrerId = linkResult.rows[0]!.referrer_id;
    const commissionRate = DEFAULT_COMMISSION_RATE;
    const commissionCents = Math.floor((topupAmountCents * commissionRate) / 10000);
    if (commissionCents <= 0) return;

    // Insert commission (UNIQUE on payment_id prevents double-crediting)
    await query(
      `INSERT INTO affiliate_commissions (referrer_id, referee_id, payment_id, topup_cents, commission_cents, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (payment_id) DO NOTHING`,
      [referrerId, refereeUserId, paymentId, topupAmountCents, commissionCents, commissionRate],
    );

    log.info("affiliate commission recorded", { referrerId, refereeUserId, commissionCents, paymentId });
  } catch (err) {
    // Fire-and-forget — never block the main payment flow
    log.error("failed to record affiliate commission", {
      refereeUserId,
      paymentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function creditPendingCommissions(referrerId: string): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Cap pending commissions per payout to prevent unbounded fetch
    const pendingResult = await client.query(
      `SELECT id, commission_cents FROM affiliate_commissions
       WHERE referrer_id = $1 AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1000
       FOR UPDATE`,
      [referrerId],
    );
    if (pendingResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return 0;
    }

    const totalCents = (pendingResult.rows as { commission_cents: number }[])
      .reduce((sum, r) => sum + r.commission_cents, 0);
    if (totalCents <= 0) {
      await client.query("ROLLBACK");
      return 0;
    }

    // Check wallet balance cap
    const walletResult = await client.query(
      "SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE",
      [referrerId],
    );
    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new Error("Wallet not found");
    }
    const wallet = walletResult.rows[0] as { id: string; balance_cents: number };
    if (wallet.balance_cents + totalCents > MAX_BALANCE_CENTS) {
      await client.query("ROLLBACK");
      throw new Error("Payout would exceed wallet balance cap");
    }

    // Credit wallet
    await client.query(
      "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
      [totalCents, wallet.id],
    );
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'topup', $2, $3)`,
      [wallet.id, totalCents, `Affiliate commission payout (${pendingResult.rows.length} referrals)`],
    );

    // Mark commissions as credited
    const ids = (pendingResult.rows as { id: string }[]).map((r) => r.id);
    await client.query(
      `UPDATE affiliate_commissions SET status = 'credited', credited_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );

    await client.query("COMMIT");
    log.info("affiliate commissions credited", { referrerId, totalCents, count: ids.length });
    return totalCents;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getAffiliateStats(userId: string): Promise<AffiliateStats> {
  const result = await query<{
    total_referrals: string;
    active_referrals: string;
    total_commission: string;
    pending_commission: string;
    credited_commission: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM affiliate_links WHERE referrer_id = $1) AS total_referrals,
       (SELECT COUNT(*) FROM affiliate_links WHERE referrer_id = $1 AND active = true) AS active_referrals,
       (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_commissions WHERE referrer_id = $1) AS total_commission,
       (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_commissions WHERE referrer_id = $1 AND status = 'pending') AS pending_commission,
       (SELECT COALESCE(SUM(commission_cents), 0) FROM affiliate_commissions WHERE referrer_id = $1 AND status = 'credited') AS credited_commission`,
    [userId],
  );
  const row = result.rows[0]!;
  return {
    totalReferrals: parseInt(row.total_referrals, 10),
    activeReferrals: parseInt(row.active_referrals, 10),
    totalCommissionCents: parseInt(row.total_commission, 10),
    pendingCommissionCents: parseInt(row.pending_commission, 10),
    creditedCommissionCents: parseInt(row.credited_commission, 10),
  };
}

export async function listAffiliateReferees(userId: string): Promise<{
  refereeId: string;
  email: string;
  createdAt: Date;
}[]> {
  const result = await query<{ referee_id: string; email: string; created_at: Date }>(
    `SELECT al.referee_id, u.email, al.created_at
     FROM affiliate_links al
     JOIN users u ON u.id = al.referee_id
     WHERE al.referrer_id = $1 AND al.active = true
     ORDER BY al.created_at DESC
     LIMIT 100`,
    [userId],
  );
  return result.rows.map((r) => ({
    refereeId: r.referee_id,
    // Mask email: show first 2 chars + ***@domain
    email: r.email.length > 4
      ? r.email.slice(0, 2) + "***" + r.email.slice(r.email.indexOf("@"))
      : "***@***",
    createdAt: r.created_at,
  }));
}

export async function listCommissions(userId: string): Promise<AffiliateCommission[]> {
  const result = await query<AffiliateCommission>(
    `SELECT id, referrer_id, referee_id, payment_id, topup_cents, commission_cents, commission_rate, status, credited_at, created_at
     FROM affiliate_commissions WHERE referrer_id = $1
     ORDER BY created_at DESC LIMIT 200`,
    [userId],
  );
  return result.rows;
}

// ─── Promo Codes ─────────────────────────────────────────────────────

export async function createPromoCode(
  adminUserId: string,
  codeHash: string,
  codePrefix: string,
  creditCents: number,
  options?: { maxUses?: number; expiresAt?: Date },
  ext?: DbTxClient,
): Promise<PromoCode> {
  // Validate creditCents at repo level (defense-in-depth, matches createReferralCode)
  if (!Number.isFinite(creditCents) || creditCents < 0 || creditCents > 100000) {
    throw new Error("creditCents must be between 0 and 100000");
  }
  // Do not return code_hash from RETURNING — hash must not leave DB boundary
  const result = await queryOn<PromoCode>(ext,
    `INSERT INTO promo_codes (admin_user_id, code_hash, code_prefix, credit_cents, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, admin_user_id, code_prefix, credit_cents, max_uses, uses, active, expires_at, created_at`,
    [adminUserId, codeHash, codePrefix, creditCents, options?.maxUses ?? 0, options?.expiresAt ?? null],
  );
  return result.rows[0] as PromoCode;
}

export async function findPromoCodeByHash(codeHash: string): Promise<PromoCode | null> {
  const result = await query<PromoCode>(
    `SELECT id, admin_user_id, code_hash, code_prefix, credit_cents, max_uses, uses, active, expires_at, created_at
     FROM promo_codes
     WHERE code_hash = $1 AND active = true
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_uses = 0 OR uses < max_uses)`,
    [codeHash],
  );
  return result.rows[0] ?? null;
}

export async function redeemPromoCode(
  codeHash: string,
  userId: string,
): Promise<PromoRedemption | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the promo code
    const codeResult = await client.query(
      `SELECT id, credit_cents, max_uses, uses
       FROM promo_codes
       WHERE code_hash = $1 AND active = true
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (max_uses = 0 OR uses < max_uses)
       FOR UPDATE`,
      [codeHash],
    );
    const code = codeResult.rows[0] as { id: string; credit_cents: number; max_uses: number; uses: number } | undefined;
    if (!code) {
      await client.query("ROLLBACK");
      return null;
    }

    // Check if user already redeemed this promo (UNIQUE constraint)
    const existingResult = await client.query(
      "SELECT 1 FROM promo_redemptions WHERE promo_code_id = $1 AND user_id = $2",
      [code.id, userId],
    );
    if (existingResult.rows.length > 0) {
      await client.query("ROLLBACK");
      throw new Error("You have already redeemed this promo code");
    }

    // Use RETURNING to capture updated uses count (consistency with referral uses fix)
    await client.query("UPDATE promo_codes SET uses = uses + 1 WHERE id = $1 RETURNING uses", [code.id]);

    // Credit wallet (with balance cap check)
    const walletResult = await client.query(
      "SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    if (walletResult.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new Error("Wallet not found");
    }
    const wallet = walletResult.rows[0] as { id: string; balance_cents: number };
    if (wallet.balance_cents + code.credit_cents > MAX_BALANCE_CENTS) {
      await client.query("ROLLBACK");
      throw new Error("Wallet would exceed balance cap");
    }

    await client.query(
      "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
      [code.credit_cents, wallet.id],
    );
    await client.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
       VALUES ($1, 'topup', $2, $3)`,
      [wallet.id, code.credit_cents, "Promo code redemption"],
    );

    // Create redemption record
    const redemptionResult = await client.query(
      `INSERT INTO promo_redemptions (promo_code_id, user_id, credit_cents)
       VALUES ($1, $2, $3)
       RETURNING id, promo_code_id, user_id, credit_cents, created_at`,
      [code.id, userId, code.credit_cents],
    );

    await client.query("COMMIT");
    return redemptionResult.rows[0] as PromoRedemption;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listPromoCodes(): Promise<Omit<PromoCode, "code_hash">[]> {
  // Never return code_hash in list queries
  const result = await query<Omit<PromoCode, "code_hash">>(
    `SELECT id, admin_user_id, code_prefix, credit_cents, max_uses, uses, active, expires_at, created_at
     FROM promo_codes ORDER BY created_at DESC LIMIT 200`,
  );
  return result.rows;
}

export async function disablePromoCode(codeId: string, ext?: DbTxClient): Promise<boolean> {
  const result = await queryOn(ext,
    "UPDATE promo_codes SET active = false WHERE id = $1 AND active = true",
    [codeId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Loyalty ─────────────────────────────────────────────────────────

export async function getLoyaltyTiers(): Promise<LoyaltyTier[]> {
  const result = await query<LoyaltyTier>(
    "SELECT id, name, min_spend_bytes, cashback_basis_pts, sort_order FROM loyalty_tiers ORDER BY sort_order ASC",
  );
  return result.rows;
}

export async function calculateLoyaltyStatus(userId: string): Promise<LoyaltyStatus> {
  // Get current month usage bytes
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const usageResult = await query<{ total_bytes: string }>(
    `SELECT COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes
     FROM usage_records WHERE user_id = $1 AND created_at >= $2`,
    [userId, monthStart.toISOString()],
  );
  const totalBytes = parseInt(usageResult.rows[0]?.total_bytes ?? "0", 10);

  // Get all tiers sorted
  const tiers = await getLoyaltyTiers();

  // Handle empty loyalty_tiers table gracefully instead of crashing
  if (tiers.length === 0) {
    return {
      currentTier: { id: "none", name: "None", min_spend_bytes: 0, cashback_basis_pts: 0, sort_order: 0 },
      currentMonthSpendBytes: totalBytes,
      nextTier: null,
      bytesToNextTier: 0,
    };
  }

  // Find current tier (highest tier where user meets min_spend_bytes)
  let currentTier = tiers[0]!; // 'none' tier
  let nextTier: LoyaltyTier | null = null;

  for (let i = tiers.length - 1; i >= 0; i--) {
    if (totalBytes >= tiers[i]!.min_spend_bytes) {
      currentTier = tiers[i]!;
      nextTier = tiers[i + 1] ?? null;
      break;
    }
  }

  const bytesToNextTier = nextTier ? Math.max(0, nextTier.min_spend_bytes - totalBytes) : 0;

  return {
    currentTier,
    currentMonthSpendBytes: totalBytes,
    nextTier,
    bytesToNextTier,
  };
}

export async function calculateAndRecordMonthlyReward(
  userId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<LoyaltyReward | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if already recorded (UNIQUE on user_id + period_start)
    const existing = await client.query(
      "SELECT 1 FROM loyalty_rewards WHERE user_id = $1 AND period_start = $2",
      [userId, periodStart.toISOString().slice(0, 10)],
    );
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return null; // Already recorded
    }

    // Calculate spend in the period
    const spendResult = await client.query(
      `SELECT COALESCE(SUM(cost_cents), 0) AS total_spend,
              COALESCE(SUM(bytes_in + bytes_out), 0) AS total_bytes
       FROM usage_records
       WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [userId, periodStart.toISOString(), periodEnd.toISOString()],
    );
    const totalSpendCents = parseInt((spendResult.rows[0] as { total_spend: string }).total_spend, 10);
    const totalBytes = parseInt((spendResult.rows[0] as { total_bytes: string }).total_bytes, 10);

    if (totalSpendCents <= 0) {
      await client.query("ROLLBACK");
      return null;
    }

    // Find the tier for total_bytes
    const tierResult = await client.query(
      "SELECT id, cashback_basis_pts FROM loyalty_tiers WHERE min_spend_bytes <= $1 ORDER BY min_spend_bytes DESC LIMIT 1",
      [totalBytes],
    );
    const tier = tierResult.rows[0] as { id: string; cashback_basis_pts: number } | undefined;
    if (!tier || tier.cashback_basis_pts <= 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const rewardCents = Math.floor((totalSpendCents * tier.cashback_basis_pts) / 10000);
    if (rewardCents <= 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const result = await client.query(
      `INSERT INTO loyalty_rewards (user_id, tier_id, period_start, period_end, spend_cents, reward_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, tier_id, period_start, period_end, spend_cents, reward_cents, status, credited_at, created_at`,
      [userId, tier.id, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10), totalSpendCents, rewardCents],
    );

    await client.query("COMMIT");
    return result.rows[0] as LoyaltyReward;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function creditPendingLoyaltyRewards(): Promise<number> {
  const pool = getPool();
  let totalCredited = 0;
  // Cap iterations to prevent unbounded processing
  const MAX_REWARDS_PER_BATCH = 1000;
  let iterations = 0;

  for (;;) {
    if (iterations >= MAX_REWARDS_PER_BATCH) {
      log.info("creditPendingLoyaltyRewards: batch limit reached", { iterations, totalCredited });
      break;
    }
    // Acquire a fresh client per iteration to avoid stale client state
    // after ROLLBACK errors (PostgreSQL clients can retain error state)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Each reward locked with FOR UPDATE SKIP LOCKED
      const pendingResult = await client.query<{ id: string; user_id: string; reward_cents: number }>(
        "SELECT id, user_id, reward_cents FROM loyalty_rewards WHERE status = 'pending' LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (pendingResult.rows.length === 0) {
        await client.query("ROLLBACK");
        break; // No more pending rewards
      }
      const reward = pendingResult.rows[0]!;

      // Lock wallet
      const walletResult = await client.query(
        "SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE",
        [reward.user_id],
      );
      if (walletResult.rows.length === 0) {
        // Log warning for orphaned rewards (wallet deleted/missing)
        log.warn("loyalty reward skipped: wallet not found", { rewardId: reward.id, userId: reward.user_id });
        await client.query("ROLLBACK");
        iterations++;
        continue;
      }
      const wallet = walletResult.rows[0] as { id: string; balance_cents: number };
      if (wallet.balance_cents + reward.reward_cents > MAX_BALANCE_CENTS) {
        // Log when reward skipped due to balance cap
        log.warn("loyalty reward skipped: would exceed balance cap", { rewardId: reward.id, userId: reward.user_id });
        await client.query("ROLLBACK");
        iterations++;
        continue;
      }

      await client.query(
        "UPDATE wallets SET balance_cents = balance_cents + $1 WHERE id = $2",
        [reward.reward_cents, wallet.id],
      );
      await client.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description)
         VALUES ($1, 'topup', $2, 'Loyalty reward')`,
        [wallet.id, reward.reward_cents],
      );
      await client.query(
        "UPDATE loyalty_rewards SET status = 'credited', credited_at = NOW() WHERE id = $1",
        [reward.id],
      );

      await client.query("COMMIT");
      totalCredited += reward.reward_cents;
      iterations++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      log.error("failed to credit loyalty reward", {
        error: err instanceof Error ? err.message : String(err),
      });
      iterations++;
    } finally {
      client.release();
    }
  }

  return totalCredited;
}

export async function getLoyaltyHistory(userId: string): Promise<LoyaltyReward[]> {
  const result = await query<LoyaltyReward>(
    `SELECT id, user_id, tier_id, period_start, period_end, spend_cents, reward_cents, status, credited_at, created_at
     FROM loyalty_rewards WHERE user_id = $1 ORDER BY period_start DESC LIMIT 24`,
    [userId],
  );
  return result.rows;
}
