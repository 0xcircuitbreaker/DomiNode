import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import ThemeToggle from "../components/ThemeToggle";
import { BRAND_NAME } from "../config/branding";
import { cx } from "./components/ui";

export const NAV: Array<{ to: string; label: string; icon: string; group: string }> = [
  { to: "/admin", label: "Overview", group: "Monitor", icon: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z" },
  { to: "/admin/revenue", label: "Revenue", group: "Monitor", icon: "M3 17l6-6 4 4 8-8M14 7h7v7" },
  { to: "/admin/network", label: "Network", group: "Monitor", icon: "M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.5-2.5 3.5-5.5 3.5-9S14.5 5.5 12 3m0 18c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3M3.5 9h17M3.5 15h17" },
  { to: "/admin/health", label: "Health", group: "Monitor", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { to: "/admin/nodes", label: "Nodes", group: "Operate", icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" },
  { to: "/admin/agents", label: "Agents", group: "Operate", icon: "M17 20h5v-2a3 3 0 00-5.4-1.8M9 20H2v-2a3 3 0 015.4-1.8M15 7a3 3 0 11-6 0 3 3 0 016 0zM12 14a5 5 0 00-5 5v1h10v-1a5 5 0 00-5-5z" },
  { to: "/admin/credits", label: "Credits & Payouts", group: "Operate", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
  { to: "/admin/disputes", label: "Disputes", group: "Operate", icon: "M3 6l9-3 9 3M3 6v2a9 9 0 0018 0V6M12 3v18" },
  { to: "/admin/launch", label: "Launch controls", group: "Operate", icon: "M5 19l4-4m0 0l6-6 4 4-6 6-4-4zm6-6l2-7 3 3-5 4z" },
  { to: "/admin/abuse", label: "Abuse log", group: "Operate", icon: "M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" },
  { to: "/admin/policy", label: "Policy", group: "Configure", icon: "M9 12l2 2 4-4m5.6-4A12 12 0 0112 3a12 12 0 01-8.6 3A12 12 0 003 9c0 5.6 3.8 10.3 9 11.6 5.2-1.3 9-6 9-11.6 0-1-.1-2-.4-3z" },
  { to: "/admin/pricing", label: "Pricing, Split & Tiers", group: "Configure", icon: "M7 7h.01M7 3h5a2 2 0 011.4.6l7 7a2 2 0 010 2.8l-7 7a2 2 0 01-2.8 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" },
  { to: "/admin/audit", label: "Audit", group: "Configure", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const groups = [...new Set(NAV.map((n) => n.group))];
  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 py-4">
      {groups.map((g) => (
        <div key={g} className="mb-4">
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/admin"} onClick={onNavigate}
              className={({ isActive }) => cx(
                "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
              )}>
              <Icon d={n.icon} />
              <span className="truncate">{n.label}</span>
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/logo.svg" alt="" className="h-8 w-8" />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{BRAND_NAME}</div>
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">Operator console</div>
      </div>
    </div>
  );
}

export function AccessDenied() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Access denied</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          This console is for network operators only. {user?.email ? <>The account <strong className="break-all">{user.email}</strong> does not have an admin role.</> : null}
        </p>
        <button type="button" className="btn-secondary mt-5" onClick={() => void logout()}>Sign out</button>
      </div>
    </div>
  );
}

export function isAdminUser(user: { admin_role?: string } | null): boolean {
  return !!user && !!user.admin_role && user.admin_role !== "none";
}

export default function AdminLayout() {
  const { user, loading, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (loading) {
    return <div role="status" className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500 dark:bg-slate-950">Loading…</div>;
  }
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?redirect=${encodeURIComponent(next)}`} replace />;
  }
  if (!isAdminUser(user)) return <AccessDenied />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:flex">
        <div className="border-b border-slate-200 px-4 py-4 dark:border-slate-800"><Brand /></div>
        <SideNav />
      </aside>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/40" onClick={() => setMenuOpen(false)} aria-hidden />
          <aside className="relative flex h-full w-64 flex-col bg-white shadow-xl dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <Brand />
              <button type="button" aria-label="Close menu" className="btn-secondary !px-2" onClick={() => setMenuOpen(false)}>✕</button>
            </div>
            <SideNav onNavigate={() => setMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" aria-label="Open menu" className="btn-secondary !px-2 lg:hidden" onClick={() => setMenuOpen(true)}>☰</button>
            <span className="truncate text-sm text-slate-500 dark:text-slate-400 lg:hidden">{BRAND_NAME}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden truncate text-sm text-slate-600 dark:text-slate-300 sm:inline" title={user.admin_role}>
              {user.email} <span className="text-xs text-slate-400">({user.admin_role.replace(/_/g, " ")})</span>
            </span>
            <ThemeToggle compact />
            <button type="button" className="btn-secondary" onClick={() => void logout()}>Sign out</button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-3 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
