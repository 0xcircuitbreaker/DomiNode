import { walletRepo } from "@dominusnode/shared";

interface CacheEntry {
  balanceCents: number;
  cachedAt: number;
}

const CACHE_TTL_MS = parseInt(process.env["BALANCE_CACHE_TTL_MS"] ?? "5000", 10);
const MAX_CACHE_SIZE = 10_000;
const cache = new Map<string, CacheEntry>();

export async function checkBalance(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(userId);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.balanceCents > 0;
  }

  // H4 fix: O(1) LRU eviction using Map insertion order instead of O(n log n) sort
  if (cache.size >= MAX_CACHE_SIZE) {
    // Maps iterate in insertion order — delete the first half (oldest)
    let toDelete = Math.floor(MAX_CACHE_SIZE / 2);
    for (const key of cache.keys()) {
      if (toDelete <= 0) break;
      cache.delete(key);
      toDelete--;
    }
  }

  const balance = await walletRepo.getBalance(userId);
  cache.set(userId, { balanceCents: balance, cachedAt: now });
  return balance > 0;
}

export function invalidateBalanceCache(userId: string): void {
  cache.delete(userId);
}
