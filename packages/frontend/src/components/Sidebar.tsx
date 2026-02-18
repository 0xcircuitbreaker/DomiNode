import { NavLink, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";

const links = [
  { to: "/app", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" },
  { to: "/app/keys", label: "API Keys", icon: "M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" },
  { to: "/app/wallet", label: "Wallet", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
  { to: "/app/usage", label: "Usage", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { to: "/app/plans", label: "Plans", icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" },
  { to: "/app/security", label: "Security", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
];

const adminLink = {
  to: "/app/admin",
  label: "Admin",
  // Shield/cog icon for admin
  icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
};

export default function Sidebar() {
  const { isAdmin } = useAuth();

  const allLinks = isAdmin ? [...links, adminLink] : links;

  return (
    <aside className="app-sidebar w-64 bg-gray-900 border-r border-gray-800 flex flex-col min-h-screen">
      <div className="app-sidebar-brand p-6">
        <div className="flex items-center gap-3">
          <img src="/logo.svg" alt={BRAND_MARK} className="app-brand-mark" style={{ width: "2.8rem", height: "2.8rem" }} />
          <div className="app-hide-compact">
            <h1 className="text-xl font-bold text-indigo-400">{BRAND_NAME}</h1>
            <p className="app-brand-subtitle">Client Control Plane</p>
          </div>
        </div>
      </div>

      <nav className="app-sidebar-nav flex-1 px-3 grid gap-1 content-start">
        {allLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === "/app"}
            className={({ isActive }) => {
              const base = "app-nav-link flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors";
              const tone = isActive
                ? "app-nav-link-active bg-indigo-500/10 text-indigo-400"
                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800";
              return `${base} ${tone}`;
            }}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
            </svg>
            <span className="app-nav-link-label app-hide-compact">{link.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="app-sidebar-footer p-4 border-t border-gray-800">
        <div className="app-footer-note app-hide-compact">
          <p className="text-xs text-gray-600 font-semibold">DC &amp; Residential Proxy Pool</p>
          <div className="flex gap-3 mt-2">
            <Link to="/" className="app-link text-xs">Website</Link>
            <Link to="/privacy" className="app-link text-xs">Privacy</Link>
            <Link to="/terms" className="app-link text-xs">Terms</Link>
          </div>
        </div>
      </div>
    </aside>
  );
}
