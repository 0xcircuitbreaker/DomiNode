import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, bodyClassName }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cx("min-w-0 rounded-sm border border-slate-200 bg-white shadow-sm dark:border-white/10 dark:bg-ddg-surface", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-white/10">
          {title && <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, sub, tone, children }: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "bad" | "good"; children?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-sm border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-ddg-surface">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {tone && <StatusDot tone={tone} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
      {children}
    </div>
  );
}

export function StatusDot({ tone }: { tone: "warn" | "bad" | "good" | "muted" }) {
  const color = { warn: "bg-amber-500", bad: "bg-red-500", good: "bg-emerald-500", muted: "bg-slate-400" }[tone];
  return <span aria-hidden className={cx("inline-block h-2 w-2 flex-shrink-0 rounded-full", color)} />;
}

const BADGE_TONES: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/30",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30",
  bad: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/30",
  info: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/30",
  muted: "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600/40",
};
const STATUS_TONE: Record<string, keyof typeof BADGE_TONES> = {
  active: "good", confirmed: "good", resolved_gateway: "good", online: "good", ok: "good",
  pending: "info", submitted: "info", cooldown: "warn", held_tax: "warn", held_frozen: "warn", open: "warn",
  frozen: "bad", quarantined: "bad", suspended: "bad", failed: "bad", stale: "bad", resolved_node: "warn",
  revoked: "muted", reversed: "muted", dismissed: "muted", deleted: "muted", offline: "muted",
};

export function Badge({ children, tone }: { children: ReactNode; tone?: keyof typeof BADGE_TONES }) {
  const key = tone ?? (typeof children === "string" ? STATUS_TONE[children] : undefined) ?? "muted";
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset", BADGE_TONES[key])}>
      {typeof children === "string" ? children.replace(/_/g, " ") : children}
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div role="status" className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{label}</div>;
}

export function ErrorBox({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <span className="min-w-0 break-words">{error}</span>
      {onRetry && <button type="button" className="btn-secondary !py-1 text-xs" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "good" | "warn" }) {
  const cls = {
    info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
    good: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  }[tone];
  return <div role="status" className={cx("mb-4 rounded-lg border px-3 py-2 text-sm", cls)}>{children}</div>;
}

// ─── Table ──────────────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
  sortKey?: string;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, sort, onSort, empty = "No results", caption }: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void;
  sort?: { key: string; order: "asc" | "desc" }; onSort?: (key: string) => void; empty?: ReactNode; caption?: string;
}) {
  return (
    <div className="relative -mx-4 overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-white/10 dark:text-slate-400">
            {columns.map((c) => {
              const active = sort && c.sortKey && sort.key === c.sortKey;
              return (
                <th key={c.key} scope="col"
                  aria-sort={active ? (sort!.order === "asc" ? "ascending" : "descending") : undefined}
                  className={cx("whitespace-nowrap px-4 py-2 font-medium", c.align === "right" ? "text-right" : "text-left")}>
                  {c.sortKey && onSort ? (
                    <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-slate-900 dark:hover:text-slate-100" onClick={() => onSort(c.sortKey!)}>
                      {c.header}<span aria-hidden>{active ? (sort!.order === "asc" ? "▲" : "▼") : "↕"}</span>
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">{empty}</td></tr>
          ) : rows.map((r) => (
            <tr key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(r); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              className={cx("border-b border-slate-100 text-slate-700 last:border-0 dark:border-white/5 dark:text-slate-300",
                onRowClick && "cursor-pointer hover:bg-slate-50 focus:bg-slate-50 focus:outline-none dark:hover:bg-slate-800/50 dark:focus:bg-slate-800/50")}>
              {columns.map((c) => (
                <td key={c.key} className={cx("whitespace-nowrap px-4 py-2", c.align === "right" && "text-right tabular-nums", c.className)}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ limit, offset, total, onChange }: { limit: number; offset: number; total: number; onChange: (offset: number) => void }) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500 dark:text-slate-400">
      <span>{from}–{to} of {total.toLocaleString("en-US")}</span>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</button>
        <button type="button" className="btn-secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</button>
      </div>
    </div>
  );
}

// ─── Form controls ─────────────────────────────────────────────────

export function Field({ label, children, hint, className }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</label>
      {children(id)}
      {hint && <span className="text-xs text-slate-500 dark:text-slate-500">{hint}</span>}
    </div>
  );
}

export function SelectFilter({ label, value, onChange, options, allLabel = "All" }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<string | { value: string; label: string }>; allLabel?: string | null;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {allLabel !== null && <option value="">{allLabel}</option>}
          {options.map((o) => {
            const v = typeof o === "string" ? o : o.value;
            const l = typeof o === "string" ? o.replace(/_/g, " ") : o.label;
            return <option key={v} value={v}>{l}</option>;
          })}
        </select>
      )}
    </Field>
  );
}

export function TextFilter({ label, value, onChange, placeholder, maxLength = 100 }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number;
}) {
  return (
    <Field label={label}>
      {(id) => <input id={id} className="input" value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-end [&>*]:lg:w-44">{children}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-800">
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={o === value} onClick={() => onChange(o)}
          className={cx("rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            o === value ? "bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")}>
          {o}
        </button>
      ))}
    </div>
  );
}

/** Debounce a fast-changing value (search inputs). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ─── Overlays ──────────────────────────────────────────────────────

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-950/40" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"}
        className="relative flex h-full w-full max-w-3xl flex-col bg-slate-50 shadow-2xl dark:bg-slate-950">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-ddg-surface">
          <h2 className="min-w-0 truncate text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          <button type="button" aria-label="Close" className="btn-secondary !px-2" onClick={onClose}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;

/**
 * Confirmation dialog for destructive admin actions. When `reason` is set the
 * confirm button stays disabled until a non-empty printable reason is entered.
 */
export function ConfirmDialog({ open, title, description, confirmLabel = "Confirm", danger, reason, reasonMax = 500, onConfirm, onClose, children }: {
  open: boolean; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean;
  reason?: "required" | "optional"; reasonMax?: number; onConfirm: (reason: string) => Promise<void>; onClose: () => void; children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEscape(open && !busy, onClose);
  useEffect(() => {
    if (open) { setText(""); setErr(null); setBusy(false); setTimeout(() => ref.current?.focus(), 0); }
  }, [open]);
  if (!open) return null;
  const trimmed = text.trim();
  const invalid = (reason === "required" && trimmed.length === 0) || trimmed.length > reasonMax || !PRINTABLE.test(trimmed);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(trimmed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
      <div className="absolute inset-0 bg-slate-950/50" onClick={busy ? undefined : onClose} aria-hidden />
      <div role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`}
        className="relative w-full max-w-md rounded-sm border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-ddg-surface">
        <h2 id={`${id}-t`} className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
        {description && <div className="mt-2 text-sm text-slate-600 dark:text-slate-400">{description}</div>}
        {children}
        {reason && (
          <div className="mt-3">
            <label htmlFor={`${id}-r`} className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Reason {reason === "required" ? "(required)" : "(optional)"}
            </label>
            <textarea id={`${id}-r`} ref={ref} rows={3} maxLength={reasonMax} className="input mt-1 w-full" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="text-right text-xs text-slate-400">{text.length}/{reasonMax}</div>
          </div>
        )}
        {err && <div role="alert" className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={danger ? "btn-danger" : "btn-primary"} onClick={go} disabled={busy || invalid}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DefList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 justify-between gap-3 border-b border-slate-100 pb-1.5 dark:border-white/10">
          <dt className="text-slate-500 dark:text-slate-400">{k}</dt>
          <dd className="min-w-0 truncate text-right font-medium text-slate-800 dark:text-slate-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return <span title={title} className="font-mono text-xs">{children}</span>;
}
