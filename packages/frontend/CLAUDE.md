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
- DDG design system in `src/ddg/` (grain, crosshair, tokens; see its README). Public pages are dark-first on it; admin uses it with toned-down grain
- `/`, `/quickstart`, `/run-a-node`, `/self-host`, `/pricing` public product site (`pages/LandingPage.tsx`, `pages/public/`, `src/site/components.tsx`, `src/landing/`): no login/admin links anywhere; live data from public `/v1/pricing|network/stats|policy` with fallback text; never hardcode prices
- Discovery files (`public/llms*.txt`, `public/docs/*.md`, robots, sitemap, `.well-known/mcp/server.json`) come from `discovery/generate.mjs`; rerun it after edits (a test checks staleness). See docs/agent-network/DISCOVERY.md
- Public: Login (+MFA), Forgot/Reset password, Verify email, Terms/Privacy/AUP
- `/admin/*` (src/admin/, gated on `admin_role != none`): Overview, Revenue, Network, Nodes, Agents,
  Credits & Payouts, Disputes, Collusion flags, Abuse log, Launch controls, Policy, Pricing/Split/Tiers, Health, Audit
- API: `src/api/admin.ts` (typed /api/admin/network client, see docs/agent-network/ADMIN_API.md)
- Charts: recharts (pinned) via `src/admin/components/charts.tsx`; colors come from `useChartTheme()`
- Money: µUSD strings → `lib/format.ts` (`fmtMoney`); CSV via `lib/csv.ts` (formula-injection guarded)
- Destructive actions always go through `ConfirmDialog` (reason required where the API requires it)
