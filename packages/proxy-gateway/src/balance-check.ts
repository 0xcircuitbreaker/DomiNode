import { walletRepo, teamRepo } from "@dominusnode/shared";

interface CacheEntry {
  balanceCents: number;
  cachedAt: number;
}

// R19 H-4: Cap TTL at 30s to limit free bandwidth window from stale cache
const rawCacheTtl = parseInt(process.env["BALANCE_CACHE_TTL_MS"] ?? "5000", 10);
const CACHE_TTL_MS = Math.min(Math.max(isNaN(rawCacheTtl) ? 5000 : rawCacheTtl, 1000), 30_000);
const MIN_RESERVATION_CENTS = 50;
const MAX_CACHE_SIZE = 10_000;
const cache = new Map<string, CacheEntry>();

function evictIfNeeded(): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    let toDelete = Math.floor(MAX_CACHE_SIZE / 2);
    for (const key of cache.keys()) {
      if (toDelete <= 0) break;
      cache.delete(key);
      toDelete--;
    }
  }
}

export async function checkBalance(userId: string): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(userId);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.balanceCents >= MIN_RESERVATION_CENTS;
  }

  evictIfNeeded();

  const balance = await walletRepo.getBalance(userId);
  cache.set(userId, { balanceCents: balance, cachedAt: now });
  return balance >= MIN_RESERVATION_CENTS;
}

/** Check team wallet balance (separate cache key prefix to avoid collisions) */
export async function checkTeamBalance(teamId: string): Promise<boolean> {
  const cacheKey = `team:${teamId}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.balanceCents >= MIN_RESERVATION_CENTS;
  }

  evictIfNeeded();

  const balance = await teamRepo.getTeamBalance(teamId);
  cache.set(cacheKey, { balanceCents: balance, cachedAt: now });
  return balance >= MIN_RESERVATION_CENTS;
}

export function invalidateBalanceCache(userId: string): void {
  cache.delete(userId);
}

export function invalidateTeamBalanceCache(teamId: string): void {
  cache.delete(`team:${teamId}`);
}
