import * as net from "node:net";

/**
 * Rate-limit key for a client address. IPv4 is used as-is; IPv6 is reduced to
 * its /64, the smallest block a single host or customer is normally given,
 * so one host cannot rotate source addresses inside its /64 to get a fresh
 * budget (or to flood a limiter's key map). Non-IP keys pass through.
 */
export function ipRateKey(raw: string | undefined | null): string {
  let ip = (raw ?? "").trim();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  const z = ip.indexOf("%");
  if (z >= 0) ip = ip.slice(0, z);
  if (net.isIPv6(ip)) {
    const groups = expandV6(ip);
    if (groups) return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return ip;
}

function expandV6(ip: string): string[] | null {
  let s = ip.toLowerCase();
  // Embedded IPv4 tail (e.g. 64:ff9b::1.2.3.4): convert to two groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8) return null;
  return all.map((g) => (parseInt(g || "0", 16) || 0).toString(16));
}
