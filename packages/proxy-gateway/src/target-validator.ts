/**
 * Thin wrapper over the shared net-guard SSRF floor.
 * Adds gateway-specific double-resolution DNS rebinding detection.
 */
import * as net from "node:net";
import {
  createLogger,
  isValidHostname,
  isValidPort,
  isBlockedIp,
  isBlockedTarget,
  resolveAndCheck,
} from "@dominusnode/shared";

export { isValidHostname, isValidPort, isBlockedTarget };

const log = createLogger("proxy:target-validator");

/**
 * Validate a target host:port for SSRF.
 * Uses double DNS resolution with a short delay to mitigate DNS rebinding attacks.
 * The attacker needs the first resolution to return a public IP and the second
 * to return a private IP — the delay between resolutions makes this significantly harder.
 */
export async function validateTarget(
  host: string,
  port: number,
): Promise<{ allowed: boolean; reason?: string; addresses?: string[] }> {
  if (!isValidHostname(host)) {
    return { allowed: false, reason: "Invalid hostname characters" };
  }
  if (!isValidPort(port)) {
    return { allowed: false, reason: "Invalid port number" };
  }
  if (net.isIP(host) !== 0) {
    if (isBlockedIp(host)) {
      return { allowed: false, reason: "Blocked: target is a private/internal address" };
    }
    return { allowed: true, addresses: [host] };
  }

  const first = await resolveAndCheck(host);
  if (!first.allowed) return { allowed: false, reason: first.reason };

  // Brief delay to defeat DNS rebinding (TTL=0 records change between resolutions)
  await new Promise((r) => setTimeout(r, 50));

  const second = await resolveAndCheck(host);
  if (!second.allowed) return { allowed: false, reason: second.reason };

  if (first.addresses && second.addresses) {
    // Compare IPv4 sets only (pre-refactor behaviour) so AAAA round-robin does not block.
    const isV4 = (a: string) => net.isIP(a) === 4;
    const firstSet = new Set(first.addresses.filter(isV4));
    const changed = second.addresses.filter(isV4).some((addr) => !firstSet.has(addr));
    if (changed) {
      log.warn("DNS rebinding suspected: addresses changed between resolutions", {
        host,
        first: first.addresses,
        second: second.addresses,
      });
      return { allowed: false, reason: "DNS rebinding detected: addresses changed between resolutions" };
    }
  }

  // Union of both resolutions: callers geo-check every address (OFAC destination).
  const addresses = [...new Set([...(first.addresses ?? []), ...(second.addresses ?? [])])];
  return { allowed: true, addresses };
}
