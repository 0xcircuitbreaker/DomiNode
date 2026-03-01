import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { get, post, del } from "../api/client";

interface ReferralCode {
  id: string;
  prefix: string;
  maxUses: number;
  uses: number;
  creditCents: number;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

interface ReferralStats {
  referral: {
    totalCodes: number;
    activeCodes: number;
    totalReferrals: number;
    totalCreditedCents: number;
  };
  affiliate: {
    totalReferrals: number;
    activeReferrals: number;
    totalCommissionCents: number;
    pendingCommissionCents: number;
    creditedCommissionCents: number;
  };
}

interface Commission {
  id: string;
  topupCents: number;
  commissionCents: number;
  commissionRate: number;
  status: string;
  creditedAt: string | null;
  createdAt: string;
}

interface Referee {
  refereeId: string;
  email: string;
  createdAt: string;
}

interface LoyaltyStatus {
  currentTier: { id: string; name: string; cashback_basis_pts: number };
  currentMonthSpendBytes: number;
  nextTier: { id: string; name: string; min_spend_bytes: number } | null;
  bytesToNextTier: number;
}

interface LoyaltyReward {
  id: string;
  tier_id: string;
  period_start: string;
  period_end: string;
  spend_cents: number;
  reward_cents: number;
  status: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function ReferralsPage() {
  const [promoCode, setPromoCode] = useState("");
  const [promoMsg, setPromoMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  const { data: codes, refetch: refetchCodes } = useApi<{ codes: ReferralCode[] }>(
    () => get("/api/referrals/codes"),
  );
  const { data: stats, refetch: refetchStats } = useApi<ReferralStats>(
    () => get("/api/referrals/stats"),
  );
  const { data: referees } = useApi<{ referees: Referee[] }>(
    () => get("/api/referrals/referees"),
  );
  const { data: commissions } = useApi<{ commissions: Commission[] }>(
    () => get("/api/referrals/commissions"),
  );
  const { data: loyalty } = useApi<LoyaltyStatus>(
    () => get("/api/referrals/loyalty"),
  );
  const { data: loyaltyHistory } = useApi<{ rewards: LoyaltyReward[] }>(
    () => get("/api/referrals/loyalty/history"),
  );

  async function handleCreateCode() {
    setCreateLoading(true);
    setNewCode(null);
    try {
      const res = await post<{ code: string }>("/api/referrals/code", {});
      setNewCode(res.code);
      refetchCodes();
      refetchStats();
    } catch (err) {
      setPromoMsg({ type: "err", text: err instanceof Error ? err.message : "Failed to create code" });
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleDisableCode(id: string) {
    try {
      await del(`/api/referrals/codes/${id}`);
      refetchCodes();
      refetchStats();
    } catch {
      // Silent fail
    }
  }

  async function handleRedeemPromo(e: React.FormEvent) {
    e.preventDefault();
    setPromoMsg(null);
    setPromoLoading(true);
    try {
      const res = await post<{ creditCents: number }>("/api/referrals/promo/redeem", { code: promoCode });
      setPromoMsg({ type: "ok", text: `${formatCents(res.creditCents)} credited to your wallet!` });
      setPromoCode("");
    } catch (err) {
      setPromoMsg({ type: "err", text: err instanceof Error ? err.message : "Redemption failed" });
    } finally {
      setPromoLoading(false);
    }
  }

  async function handlePayout() {
    setPayoutLoading(true);
    try {
      const res = await post<{ amountCents: number; message?: string }>("/api/referrals/commissions/payout");
      if (res.amountCents > 0) {
        setPromoMsg({ type: "ok", text: `${formatCents(res.amountCents)} commission paid out!` });
      } else {
        setPromoMsg({ type: "ok", text: res.message ?? "No pending commissions" });
      }
      refetchStats();
    } catch (err) {
      setPromoMsg({ type: "err", text: err instanceof Error ? err.message : "Payout failed" });
    } finally {
      setPayoutLoading(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  const baseUrl = window.location.origin;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-white">Referrals & Rewards</h1>

      {promoMsg && (
        <div className={`p-3 rounded-lg text-sm ${promoMsg.type === "ok" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
          {promoMsg.text}
        </div>
      )}

      {/* ─── Stats Cards ─────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Referrals</p>
          <p className="text-2xl font-bold text-white mt-1">{stats?.referral.totalReferrals ?? 0}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Credits Earned</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{formatCents(stats?.referral.totalCreditedCents ?? 0)}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Pending Commission</p>
          <p className="text-2xl font-bold text-yellow-400 mt-1">{formatCents(stats?.affiliate.pendingCommissionCents ?? 0)}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Total Commission</p>
          <p className="text-2xl font-bold text-indigo-400 mt-1">{formatCents(stats?.affiliate.totalCommissionCents ?? 0)}</p>
        </div>
      </div>

      {/* ─── Referral Codes ──────────────────────────────── */}
      <section className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Your Referral Codes</h2>
          <button
            onClick={handleCreateCode}
            disabled={createLoading}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {createLoading ? "Creating..." : "Create Code"}
          </button>
        </div>

        {newCode && (
          <div className="mb-4 p-3 bg-indigo-500/10 border border-indigo-500/20 rounded-lg flex items-center gap-3">
            <code className="text-indigo-300 font-mono text-lg flex-1">{newCode}</code>
            <button
              onClick={() => copyToClipboard(newCode)}
              className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 border border-indigo-500/30 rounded"
            >
              Copy
            </button>
            <button
              onClick={() => copyToClipboard(`${baseUrl}/login?mode=register&ref=${newCode}`)}
              className="text-xs text-indigo-400 hover:text-indigo-300 px-2 py-1 border border-indigo-500/30 rounded"
            >
              Copy Link
            </button>
          </div>
        )}

        <p className="text-sm text-gray-400 mb-3">
          Share your code to earn $1.00 for both you and the new user. You also earn 10% commission on their future top-ups.
        </p>

        {codes?.codes.length === 0 && (
          <p className="text-gray-500 text-sm">No referral codes yet. Create one above.</p>
        )}
        {codes?.codes.map((c) => (
          <div key={c.id} className="flex items-center gap-4 py-2 border-b border-gray-700/50 last:border-0">
            <code className="text-gray-300 font-mono">{c.prefix}****</code>
            <span className="text-xs text-gray-400">{c.uses}{c.maxUses > 0 ? `/${c.maxUses}` : ""} uses</span>
            <span className="text-xs text-gray-400">{formatCents(c.creditCents)}/use</span>
            <span className={`text-xs px-2 py-0.5 rounded ${c.active ? "bg-green-500/10 text-green-400" : "bg-gray-600 text-gray-400"}`}>
              {c.active ? "Active" : "Disabled"}
            </span>
            {c.active && (
              <button
                onClick={() => handleDisableCode(c.id)}
                className="text-xs text-red-400 hover:text-red-300 ml-auto"
              >
                Disable
              </button>
            )}
          </div>
        ))}
      </section>

      {/* ─── Affiliate ───────────────────────────────────── */}
      <section className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Affiliate Program</h2>
          {(stats?.affiliate.pendingCommissionCents ?? 0) > 0 && (
            <button
              onClick={handlePayout}
              disabled={payoutLoading}
              className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              {payoutLoading ? "..." : `Payout ${formatCents(stats?.affiliate.pendingCommissionCents ?? 0)}`}
            </button>
          )}
        </div>

        <p className="text-sm text-gray-400 mb-4">
          Earn 10% commission on every top-up from users you referred. Commissions accumulate and can be paid out once per day.
        </p>

        {referees?.referees.length === 0 && (
          <p className="text-gray-500 text-sm">No referrals yet. Share your code to get started.</p>
        )}
        {(referees?.referees ?? []).slice(0, 10).map((r) => (
          <div key={r.refereeId} className="flex items-center gap-4 py-2 border-b border-gray-700/50 last:border-0">
            <span className="text-gray-300 text-sm">{r.email}</span>
            <span className="text-xs text-gray-500 ml-auto">{new Date(r.createdAt).toLocaleDateString()}</span>
          </div>
        ))}

        {(commissions?.commissions ?? []).length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Recent Commissions</h3>
            <div className="space-y-1">
              {commissions!.commissions.slice(0, 5).map((c) => (
                <div key={c.id} className="flex items-center gap-4 text-sm py-1">
                  <span className="text-green-400">{formatCents(c.commissionCents)}</span>
                  <span className="text-gray-500">from {formatCents(c.topupCents)} top-up</span>
                  <span className={`text-xs px-2 py-0.5 rounded ml-auto ${c.status === "credited" ? "bg-green-500/10 text-green-400" : c.status === "pending" ? "bg-yellow-500/10 text-yellow-400" : "bg-gray-600 text-gray-400"}`}>
                    {c.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ─── Promo Code ──────────────────────────────────── */}
      <section className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-white mb-4">Redeem Promo Code</h2>
        <form onSubmit={handleRedeemPromo} className="flex gap-3">
          <input
            type="text"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
            placeholder="Enter promo code"
            maxLength={20}
            className="flex-1 bg-gray-900 border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={promoLoading || !promoCode.trim()}
            className="px-6 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-50 transition-colors"
          >
            {promoLoading ? "..." : "Apply"}
          </button>
        </form>
      </section>

      {/* ─── Loyalty ─────────────────────────────────────── */}
      <section className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
        <h2 className="text-lg font-semibold text-white mb-4">Loyalty Rewards</h2>

        {loyalty && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                loyalty.currentTier.id === "gold" ? "bg-yellow-500/20 text-yellow-400" :
                loyalty.currentTier.id === "silver" ? "bg-gray-300/20 text-gray-300" :
                loyalty.currentTier.id === "bronze" ? "bg-orange-500/20 text-orange-400" :
                "bg-gray-600/20 text-gray-400"
              }`}>
                {loyalty.currentTier.name}
              </div>
              <span className="text-sm text-gray-400">
                {loyalty.currentTier.cashback_basis_pts > 0
                  ? `${(loyalty.currentTier.cashback_basis_pts / 100).toFixed(1)}% cashback`
                  : "No cashback yet"}
              </span>
            </div>

            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>This month: {formatBytes(loyalty.currentMonthSpendBytes)}</span>
                {loyalty.nextTier && <span>Next: {loyalty.nextTier.name} ({formatBytes(loyalty.bytesToNextTier)} to go)</span>}
              </div>
              {loyalty.nextTier && (
                <div className="w-full bg-gray-700 rounded-full h-2">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (loyalty.currentMonthSpendBytes / loyalty.nextTier.min_spend_bytes) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>

            <div className="text-xs text-gray-500">
              <p>Bronze: 1 GB (2% cashback) | Silver: 10 GB (5%) | Gold: 50 GB (10%)</p>
            </div>
          </div>
        )}

        {(loyaltyHistory?.rewards ?? []).length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">Reward History</h3>
            <div className="space-y-1">
              {loyaltyHistory!.rewards.map((r) => (
                <div key={r.id} className="flex items-center gap-4 text-sm py-1">
                  <span className="text-gray-400">{r.period_start}</span>
                  <span className="text-gray-300">{r.tier_id}</span>
                  <span className="text-green-400">{formatCents(r.reward_cents)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded ml-auto ${r.status === "credited" ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"}`}>
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
