# DomiNode Frontend

Team: **Frontend**

Operator ADMIN CONTROL PANEL for the agent relay network (React 18 + Vite + Tailwind, light/dark). The only human users are admins; customer pages were removed.

## Key Files
- `src/` — React components, pages, hooks
- `vite.config.ts` — Vite configuration
- `index.html` — Entry point

## Rules
- safeJson() pattern: res.text() + size check + JSON.parse (not res.json())
- CSP meta tag in index.html conflicts with nginx CSP header — use only nginx header
- Payment URL endsWith check is subdomain-bypassable — use hostname strict match
- safeJson throws on empty body (not undefined/empty return)
- Extension proxy username: HYPHENS not underscores (country-US)
- patch() HTTP method must be exported from API client

## Pages
- Public: Login (+MFA), Forgot/Reset password, Verify email, Terms/Privacy/AUP
- `/admin/*` (src/admin/, gated on `admin_role != none`): Overview, Revenue, Network, Nodes, Agents,
  Credits & Payouts, Disputes, Abuse log, Launch controls, Policy, Pricing/Split/Tiers, Health, Audit
- API: `src/api/admin.ts` (typed /api/admin/network client, see docs/agent-network/ADMIN_API.md)
- Charts: recharts (pinned) via `src/admin/components/charts.tsx`; colors come from `useChartTheme()`
- Money: µUSD strings → `lib/format.ts` (`fmtMoney`); CSV via `lib/csv.ts` (formula-injection guarded)
- Destructive actions always go through `ConfirmDialog` (reason required where the API requires it)
