# DomiNode Frontend

Team: **Frontend**

React 18 + Vite + Tailwind CSS (dark theme) dashboard with 11 pages.

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
- ActiveSessions: never display proxyIp (upstream infrastructure detail)
- patch() HTTP method must be exported from API client

## Pages
Dashboard, API Keys, Wallet, Usage, Teams, Security, Docs, Referrals, Legal pages
