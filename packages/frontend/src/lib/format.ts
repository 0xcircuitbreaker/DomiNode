/** Number/money formatting for the admin panel. Money arrives as µUSD integer strings. */

export interface Money { musd: string; usd: string }

/** µUSD string → number of USD (safe for display; precision beyond 1e-6 not needed). */
export function musdToUsd(musd: string | number | bigint | null | undefined): number {
  if (musd === null || musd === undefined || musd === "") return 0;
  const n = Number(musd);
  return Number.isFinite(n) ? n / 1_000_000 : 0;
}

/**
 * USD with 2 decimals for amounts ≥ $1 (or zero), up to 6 decimals for sub-dollar
 * amounts so tiny relay charges stay visible.
 */
export function fmtUsdNumber(usd: number): string {
  const abs = Math.abs(usd);
  let digits = 2;
  if (abs > 0 && abs < 1) digits = abs < 0.01 ? 6 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(usd);
}

export function fmtMoney(m: Money | null | undefined): string {
  if (!m) return "—";
  return fmtUsdNumber(musdToUsd(m.musd));
}

export function fmtMusd(musd: string | number | null | undefined): string {
  if (musd === null || musd === undefined) return "—";
  return fmtUsdNumber(musdToUsd(musd));
}

/** Compact USD for chart axes ($1.2k). */
export function fmtUsdCompact(usd: number): string {
  if (Math.abs(usd) < 1) return fmtUsdNumber(usd);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(usd);
}

/** GB (decimal string or number) → "12.35 GB" / "0.004 GB". */
export function fmtGb(gb: string | number | null | undefined): string {
  if (gb === null || gb === undefined) return "—";
  const n = Number(gb);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} TB`;
  const digits = n === 0 ? 0 : n < 0.01 ? 4 : n < 10 ? 2 : 1;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} GB`;
}

export function bytesToGb(bytes: string | number | null | undefined): number {
  const n = Number(bytes ?? 0);
  return Number.isFinite(n) ? n / 1e9 : 0;
}

export function fmtBytes(bytes: string | number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n)) return "—";
  if (n < 1e3) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return fmtGb(n / 1e9);
}

export function fmtInt(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
}

/** Basis points → "30.00%". */
export function fmtBps(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined) return "—";
  return `${(bps / 100).toFixed(digits)}%`;
}

export function fmtPct(fraction: number, digits = 1): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : "—";
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return String(iso).slice(0, 10);
}

/** "3m ago" style relative time. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.round((now - t) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return "—";
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

/** Plain-number USD with 6 decimals for CSV export. */
export function csvUsd(m: Money | null | undefined): string {
  return m ? m.usd : "";
}
