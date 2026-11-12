/**
 * Starter-credit funding check (LAUNCH_PLAN §5.2 (b)): the wallet must have at
 * least one prior on-chain transaction on Base. We read the account nonce
 * (eth_getTransactionCount) from STARTER_CREDIT_RPC_URL. https only, bounded
 * timeout, small cache. Any failure returns null so callers fail closed.
 */

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const CACHE_MAX = 10_000;
const POSITIVE_TTL_MS = 24 * 60 * 60_000; // a nonce never goes back down
const NEGATIVE_TTL_MS = 5 * 60_000;
const MAX_BODY = 16 * 1024;

const cache = new Map<string, { nonce: number; at: number }>();

export function rpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): URL | null {
  const raw = env["STARTER_CREDIT_RPC_URL"];
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function rpcTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number.parseInt(env["STARTER_CREDIT_RPC_TIMEOUT_MS"] ?? "", 10);
  return Number.isInteger(v) && v >= 250 && v <= 15_000 ? v : 3000;
}

export function clearNonceCache(): void {
  cache.clear();
}

export interface NonceOpts {
  url?: URL | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
}

/** Base account nonce (number of sent transactions), or null when unknown (no/invalid RPC, timeout, bad reply). */
export async function getBaseTxCount(address: string, o: NonceOpts = {}): Promise<number | null> {
  if (!ADDR_RE.test(address)) return null;
  const key = address.toLowerCase();
  const now = o.now ?? Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < (hit.nonce > 0 ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit.nonce;
  const url = o.url === undefined ? rpcUrlFromEnv() : o.url;
  if (!url || url.protocol !== "https:") return null;
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [key, "latest"] }),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? rpcTimeoutFromEnv()),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_BODY) return null;
    const j = JSON.parse(text) as { result?: unknown };
    if (typeof j.result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(j.result)) return null;
    const nonce = Number.parseInt(j.result.slice(2), 16);
    if (!Number.isSafeInteger(nonce)) return null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { nonce, at: now });
    return nonce;
  } catch {
    return null;
  }
}
