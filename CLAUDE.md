# DomiNode

Rotating proxy-as-a-service SaaS. Users connect, get assigned a proxy IP, traffic is metered by bandwidth and billed per-GB. Burned IPs are auto-replaced.

Think: Bright Data / SmartProxy, but self-hosted and operator-controlled.

## Quick Start

```bash
docker compose up -d       # Start PostgreSQL
npm run db:migrate          # Apply schema
npm run build               # Compile all packages
npm run start:api           # REST API on :3000
npm run start:proxy         # Proxy gateway on :8080 (HTTP) + :1080 (SOCKS5)
```

## Commands

```bash
npm install                 # Install all workspace dependencies
npm run build               # Build all packages (tsc --build)
npm run clean               # Clean all build output
npm run lint                # Lint all packages
npm run format              # Format with Prettier
npx vitest run              # Run all tests
npx vitest run --coverage   # Tests with coverage
```

## Architecture

9 packages + frontend + extension + 6 SDKs + 25 AI integrations.

| Package | Purpose |
|---------|---------|
| `packages/shared` | Types, DB, auth, schema, repositories |
| `packages/proxy-gateway` | HTTP/HTTPS/SOCKS5 proxy server |
| `packages/pool-manager` | Webshare DC + residential upstream |
| `packages/metering` | Cost calculation, usage recording |
| `packages/billing` | Stripe + PayPal + NOWPayments crypto |
| `packages/dashboard` | Express REST API |
| `packages/mcp-server` | 65 MCP tools (+11 bootstrap) for AI agents: relay fetch, nodes, earnings, wallets |
| `packages/frontend` | React 18 + Vite + Tailwind dashboard |
| `packages/extension` | MV3 browser extension |

## Teams

Each area has its own `CLAUDE.md` with domain-specific rules:

| Team | Scope | Key Files |
|------|-------|-----------|
| **Core Platform** | shared, proxy-gateway, pool-manager, metering | packages/{shared,proxy-gateway,pool-manager,metering}/ |
| **Billing & Payments** | billing, wallets, x402 | packages/billing/ |
| **API & Dashboard** | REST API, auth, routes | packages/dashboard/ |
| **Frontend** | React UI, browser extension | packages/{frontend,extension}/ |
| **SDK** | All 6 language SDKs | sdks/{node,python,cpp,rust,go,java}/ |
| **AI & Integrations** | MCP server, 25 AI integrations | packages/mcp-server/, integrations/ |
| **Infrastructure** | Docker, nginx, Caddy, CI/CD, scripts | infra/, scripts/, .github/ |

## Rules System

Detailed rules are in `.claude/rules/`:
- `security.md` — SSRF, auth, credentials, GDPR, prototype pollution
- `database.md` — PostgreSQL conventions, TOCTOU prevention, repository patterns
- `testing.md` — Test conventions, verification loop
- `sdk-patterns.md` — Cross-SDK requirements, language-specific rules
- `integration-patterns.md` — AI integration security, auth, proxy routing

## Agents (`.claude/agents/`)

- `security-auditor.md` — Reviews changes for OWASP/SSRF/TOCTOU/credential leaks
- `code-reviewer.md` — Staff-engineer-level PR review
- `build-validator.md` — Verifies build + tests + lint pass
- `sdk-parity-checker.md` — Ensures all 6 SDKs stay in sync
- `integration-parity-checker.md` — Ensures all 25 integrations maintain security parity

## Slash Commands (`.claude/commands/`)

- `/audit` — Security audit on recent changes
- `/build-test` — Build + test all packages
- `/deploy-check` — Pre-deployment checklist
- `/techdebt` — Find and report technical debt
- `/add-lesson` — Add a lesson to the appropriate rules file

## Verification (Most Important Rule)

Always give yourself a way to verify your work. After every change:
1. `npm run build` — must compile
2. `npx vitest run` — tests must pass
3. If touching proxy/API: test with actual curl commands
4. If touching frontend: verify in browser

## Key Conventions

- TypeScript strict mode everywhere
- Prepaid wallet billing: Stripe + PayPal + crypto (10 currencies)
- DC $3/GB, Residential $5/GB pricing
- API key auth: SHA-256 hash, `dn_live_` prefix
- JWT: 15min access + 7d refresh tokens (family rotation)
- OFAC sanctioned countries blocked: Cuba, Iran, North Korea, Russia, Syria

## Self-Improvement Protocol

After EVERY mistake or correction:
1. Identify the correct pattern
2. Add it to the appropriate `.claude/rules/` file or package `CLAUDE.md`
3. If it's a new category, create a new rules file
4. Never repeat the same mistake twice

## Git Commit Rules

- **NEVER** add `Co-Authored-By:` trailers referencing Claude, Anthropic, or any AI tool
- Commit messages: subject line + optional body describing the change — nothing else

## Proxy Usage

```bash
# Default (auto): tries DC first, falls back to residential
curl -x http://anything:dn_live_KEY@localhost:8080 http://httpbin.org/ip

# Explicit DC ($3/GB):
curl -x http://dc-country-US:dn_live_KEY@localhost:8080 https://httpbin.org/ip

# Explicit residential ($5/GB):
curl -x http://residential-country-US:dn_live_KEY@localhost:8080 https://httpbin.org/ip
```

## Current Status

Alpha production ready. All packages compile. 2,388+ tests passing. 48 security audit rounds completed (376+ CRITICAL, 818+ HIGH findings addressed). See ARCHITECTURE.md for full implementation plan and IP sourcing strategy.
