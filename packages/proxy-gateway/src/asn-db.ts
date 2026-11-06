/**
 * Offline IP-to-ASN lookup (DESIGN.md §4, §11). Loads the public-domain
 * (PDDL v1.0) iptoasn.com `ip2asn-combined.tsv(.gz)` dataset fetched by
 * scripts/update-asn-db.sh. No license key, no runtime third-party service.
 *
 * Row format (tab separated): range_start, range_end, as_number, country, description.
 * Rows with AS 0 ("Not routed") are skipped. Ranges are kept in sorted typed
 * arrays (IPv4: Uint32, IPv6: 2 x BigUint64 per bound) and looked up by binary
 * search. Memory is bounded by MAX_ROWS (~1M rows ~= 40 MB worst case).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as zlib from "node:zlib";

export const MAX_ROWS = 1_000_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024; // decompressed cap

export interface AsnDb {
  readonly v4Count: number;
  readonly v6Count: number;
  lookup(ip: string): number | null;
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** Expand an IPv6 address to [hi64, lo64]. Handles :: and embedded IPv4. */
function ipv6ToPair(ip: string): [bigint, bigint] | null {
  if (net.isIPv6(ip) === false) return null;
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  const tail4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail4) {
    const v = ipv4ToInt(tail4[1]);
    if (v === null) return null;
    s = s.slice(0, -tail4[1].length) + ((v >>> 16) & 0xffff).toString(16) + ":" + (v & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    if (i < 4) hi = (hi << 16n) | BigInt(parseInt(g, 16));
    else lo = (lo << 16n) | BigInt(parseInt(g, 16));
  }
  return [hi, lo];
}

const cmp = (ah: bigint, al: bigint, bh: bigint, bl: bigint): number =>
  ah < bh ? -1 : ah > bh ? 1 : al < bl ? -1 : al > bl ? 1 : 0;

/** Parse dataset text. Unsorted input is sorted; overlapping rows are not merged (first-start wins). */
export function parseAsnTsv(text: string): AsnDb {
  const v4: Array<[number, number, number]> = [];
  const v6: Array<[bigint, bigint, bigint, bigint, number]> = [];
  let start = 0;
  while (start < text.length && v4.length + v6.length < MAX_ROWS) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const f = line.split("\t");
    if (f.length < 3) continue;
    const asn = Number(f[2]);
    if (!Number.isInteger(asn) || asn <= 0 || asn > 4_294_967_295) continue;
    if (f[0].includes(":")) {
      const a = ipv6ToPair(f[0]);
      const b = ipv6ToPair(f[1]);
      if (a && b && cmp(a[0], a[1], b[0], b[1]) <= 0) v6.push([a[0], a[1], b[0], b[1], asn]);
    } else {
      const a = ipv4ToInt(f[0]);
      const b = ipv4ToInt(f[1]);
      if (a !== null && b !== null && a <= b) v4.push([a, b, asn]);
    }
  }
  v4.sort((x, y) => x[0] - y[0]);
  v6.sort((x, y) => cmp(x[0], x[1], y[0], y[1]));
  const s4 = new Uint32Array(v4.length), e4 = new Uint32Array(v4.length), a4 = new Uint32Array(v4.length);
  v4.forEach((r, i) => { s4[i] = r[0]; e4[i] = r[1]; a4[i] = r[2]; });
  const n6 = v6.length;
  const sh = new BigUint64Array(n6), sl = new BigUint64Array(n6), eh = new BigUint64Array(n6), el = new BigUint64Array(n6);
  const a6 = new Uint32Array(n6);
  v6.forEach((r, i) => { sh[i] = r[0]; sl[i] = r[1]; eh[i] = r[2]; el[i] = r[3]; a6[i] = r[4]; });

  return {
    v4Count: s4.length,
    v6Count: n6,
    lookup(ip: string): number | null {
      let addr = ip;
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
      if (mapped) addr = mapped[1];
      if (net.isIPv4(addr)) {
        const x = ipv4ToInt(addr);
        if (x === null) return null;
        let lo = 0, hi = s4.length - 1, idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (s4[mid] <= x) { idx = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return idx >= 0 && x <= e4[idx] ? a4[idx] : null;
      }
      const p = ipv6ToPair(addr);
      if (!p) return null;
      let lo = 0, hi = n6 - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (cmp(sh[mid], sl[mid], p[0], p[1]) <= 0) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return idx >= 0 && cmp(p[0], p[1], eh[idx], el[idx]) <= 0 ? a6[idx] : null;
    },
  };
}

/** Load a .tsv or .tsv.gz file. Returns null if the file is missing; throws on a corrupt file. */
export function loadAsnDbFile(path: string): AsnDb | null {
  if (!fs.existsSync(path)) return null;
  let buf = fs.readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_FILE_BYTES });
  }
  if (buf.length > MAX_FILE_BYTES) throw new Error("ASN database too large");
  return parseAsnTsv(buf.toString("utf8"));
}

/**
 * Hosting / cloud ASNs used to classify a peer as `dc` (anything else with a
 * known ASN is `residential`). Hand-maintained from each provider's published
 * ASNs as listed in PeeringDB (info_type "Content" / "NSP" hosting networks)
 * and bgp.he.net. Extend at deploy time with HOSTING_ASNS="1,2,3".
 */
export const HOSTING_ASNS: ReadonlySet<number> = new Set([
  16509, 14618, 8987,       // Amazon AWS
  15169, 396982, 19527,     // Google / Google Cloud
  8075, 8068,               // Microsoft Azure
  14061,                    // DigitalOcean
  16276,                    // OVH
  24940, 213230,            // Hetzner
  63949,                    // Linode / Akamai Cloud
  20473,                    // Vultr / Choopa
  45102, 37963,             // Alibaba Cloud
  31898,                    // Oracle Cloud
  132203, 45090,            // Tencent Cloud
  51167,                    // Contabo
  12876,                    // Scaleway
  13335,                    // Cloudflare
  60781, 28753, 7203,       // Leaseweb
  36352,                    // ColoCrossing
  46606,                    // Unified Layer
  26496,                    // GoDaddy
  9009,                     // M247
  62567,                    // DigitalOcean (legacy)
  135377,                   // UCloud
  55286,                    // B2 Net / ServerMania
  40021,                    // Contabo US / Nubes
  53667,                    // FranTech / BuyVM
  197540,                   // netcup
  51852,                    // Private Layer
  396356,                   // Latitude.sh / Maxihost
]);

export function parseHostingAsns(env: string | undefined): Set<number> {
  const out = new Set(HOSTING_ASNS);
  for (const t of (env ?? "").split(",")) {
    const n = Number(t.trim());
    if (t.trim() && Number.isInteger(n) && n > 0 && n <= 4_294_967_295) out.add(n);
  }
  return out;
}

export function classifyAsn(asn: number | null, hosting: ReadonlySet<number> = HOSTING_ASNS): "dc" | "residential" | "unknown" {
  if (asn === null) return "unknown";
  return hosting.has(asn) ? "dc" : "residential";
}
