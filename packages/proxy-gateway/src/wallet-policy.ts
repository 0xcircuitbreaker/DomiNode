import { createLogger, agenticWalletRepo } from "@dominusnode/shared";

const log = createLogger("proxy:wallet-policy");

export interface WalletPolicyResult {
  allowed: boolean;
  /** True only when a walletId was supplied AND resolved to an active wallet owned by the user. */
  isAgent: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * Agentic wallet policy check (domain allowlist + daily budget).
 * Fails closed: unknown/inactive wallets, malformed allowlists and DB errors are rejected,
 * so a fabricated `wallet-<uuid>` in the username cannot unlock agent rate limits.
 */
export async function checkAgenticWalletPolicy(
  walletId: string | undefined,
  userId: string,
  targetHost: string,
): Promise<WalletPolicyResult> {
  if (!walletId) return { allowed: true, isAgent: false };

  try {
    const wallet = await agenticWalletRepo.getWallet(walletId, userId);
    if (!wallet || wallet.status !== "active") {
      return { allowed: false, isAgent: false, errorCode: "WALLET_NOT_FOUND", message: "Agentic wallet not found or inactive" };
    }

    if (wallet.allowed_domains) {
      let domains: unknown;
      try {
        domains = JSON.parse(wallet.allowed_domains);
      } catch {
        domains = null;
      }
      if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
        return { allowed: false, isAgent: false, errorCode: "WALLET_POLICY_ERROR", message: "Wallet policy could not be evaluated" };
      }
      const normalizedTarget = targetHost.toLowerCase();
      const isAllowed = (domains as string[]).some((d) => {
        const normalizedDomain = d.toLowerCase();
        return normalizedTarget === normalizedDomain || normalizedTarget.endsWith("." + normalizedDomain);
      });
      if (!isAllowed) {
        return { allowed: false, isAgent: false, errorCode: "DOMAIN_NOT_ALLOWED", message: "Target domain not in wallet allowlist" };
      }
    }

    if (wallet.daily_limit_cents !== null && wallet.daily_limit_cents > 0) {
      const dailySpend = await agenticWalletRepo.getDailySpend(walletId);
      if (dailySpend >= wallet.daily_limit_cents) {
        return { allowed: false, isAgent: false, errorCode: "BUDGET_EXCEEDED", message: "Daily budget limit reached" };
      }
    }
  } catch (err) {
    log.error("wallet policy check error", { error: err instanceof Error ? err.message : String(err), walletId });
    return { allowed: false, isAgent: false, errorCode: "WALLET_POLICY_ERROR", message: "Wallet policy could not be evaluated" };
  }

  return { allowed: true, isAgent: true };
}
