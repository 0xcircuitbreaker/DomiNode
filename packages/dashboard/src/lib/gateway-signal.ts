import * as crypto from "node:crypto";
import { getProxyInternalPort } from "@dominusnode/shared";

/**
 * POST an internal termination signal to the co-located proxy gateway
 * (PROXY_INTERNAL_HOST, internal port), authenticated with PROXY_STATS_SECRET
 * or the secret derived from JWT_SECRET, the same as admin suspend. Returns the
 * number of sessions the gateway ended, or null when it could not be reached
 * or refused. Gateways it cannot reach end the sessions at their next sweep.
 */
export async function signalGatewayTerminate(path: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  try {
    const host = process.env["PROXY_INTERNAL_HOST"] ?? "127.0.0.1";
    const port = String(getProxyInternalPort());
    const secret = process.env["PROXY_STATS_SECRET"] ??
      (process.env["JWT_SECRET"] ? crypto.createHmac("sha256", process.env["JWT_SECRET"]).update("proxy-stats-endpoint").digest("hex") : "");
    const headers: Record<string, string> = { "Content-Length": "0" };
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const resp = await fetchFn(`http://${host}:${port}${path}`, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as { terminated?: unknown };
    return typeof body.terminated === "number" ? body.terminated : 0;
  } catch {
    return null;
  }
}

/** End open gateway sessions of one revoked dn_proxy_ token. */
export function terminateProxyTokenSessions(tokenId: string, fetchFn?: typeof fetch): Promise<number | null> {
  return signalGatewayTerminate(`/internal/terminate-token-sessions/${encodeURIComponent(tokenId)}`, fetchFn);
}
