# DomiNode

DominusNode is a relay network for AI agents only: an agent-contributed exit network with an operator-run gateway (federation planned). Agents contribute residential, mobile or datacenter IPs by running `packages/node-agent`, and they buy bandwidth through the gateway. Agents that run nodes earn a share of the paid traffic that leaves through their IPs. Humans use the platform only as admins.

Design and operations docs: `docs/agent-network/` (DESIGN, ECONOMICS, PAYMENTS, AGENT_API, ADMIN_API, ABUSE_CONTROLS, DEPLOYMENT).

## Quick Start

```bash
docker compose up -d       # Start PostgreSQL
npm run db:migrate          # Apply schema
npm run build               # Compile all packages
npm run gen:coord-key       # Coordinator signing key (see docs/agent-network/DEPLOYMENT.md)
npm run start:api           # REST API on :3000
npm run start:proxy         # Relay gateway: :8080 (HTTP) + :1080 (SOCKS5) + node tunnel
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

9 packages, 6 SDKs (v2) and 27 AI integrations.

| Package | Purpose |
|---------|---------|
| `packages/shared` | Types, DB, auth, schema, repositories |
| `packages/proxy-gateway` | Relay gateway: HTTP/HTTPS/SOCKS5 front end, node selection, tunnels to exit nodes, byte metering |
| `packages/node-agent` | Agent-run exit node: dials out to the gateway and serves floor-checked TCP streams |
| `packages/metering` | Cost calculation, usage recording |
| `packages/billing` | Payment rails: x402, MPP, Tempo, NOWPayments (Stripe/PayPal admin-only) |
| `packages/dashboard` | Express REST API (`/v1` agent routes, `/api` JWT routes, admin) |
| `packages/mcp-server` | 66 MCP tools (+13 bootstrap) for AI agents: relay fetch, nodes, earnings, wallets |
| `packages/frontend` | React 18 + Vite + Tailwind admin dashboard |
| `packages/extension` | MV3 browser extension |

SDKs: `sdks/{node,python,cpp,rust,go,java}` follow `sdks/SDK_SURFACE.md` (v2). Integrations: `integrations/` (27, standard 19-tool v2 set).

## Teams

Each area has its own `CLAUDE.md` with domain-specific rules:

| Team | Scope | Key Files |
|------|-------|-----------|
| **Core Platform** | shared, proxy-gateway, node-agent, metering | packages/{shared,proxy-gateway,node-agent,metering}/ |
| **Billing & Payments** | billing, wallets, x402, MPP, Tempo | packages/billing/ |
| **API & Dashboard** | REST API, auth, routes | packages/dashboard/ |
| **Frontend** | React UI, browser extension | packages/{frontend,extension}/ |
| **SDK** | All 6 language SDKs | sdks/{node,python,cpp,rust,go,java}/ |
| **AI & Integrations** | MCP server, 27 AI integrations | packages/mcp-server/, integrations/ |
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
- `integration-parity-checker.md` — Ensures all 27 integrations maintain security parity

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
- AI agents only: wallet-identity principals with an API key (`dn_live_`) or wallet signature; no email/password or human MFA for agents. Humans are admin-only (`ADMIN_HUMAN_LOGIN`)
- Pricing comes from `network_pricing` (admin-tunable, never hardcoded). Defaults: $0.50/GB residential/mobile, $0.20/GB dc, $0.10/GB masked
- Exit class = gateway-verified class of the node's egress IP (`packages/shared/src/exit-classes.ts`), never node-reported. Tier weights per class (default 1.0/1.0/0.4/0.25) scale active-IP tier credit; see ECONOMICS.md §1a
- Node share by tier: 25% (Probation) to 50% (Partner), snapshotted at session start, with a 3–14 day maturity hold. See `docs/agent-network/ECONOMICS.md`
- Relay money is integer micro-USD (`_musd`); requester wallets debit whole cents
- Payment rails: x402 and MPP (per request), Tempo, NOWPayments crypto. Stripe/PayPal are admin-only
- Only the gateway counts billable bytes; exit nodes are untrusted
- API key auth: SHA-256 hash, `dn_live_` prefix; node keys use `dn_node_`
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
- PR titles/descriptions, issue and review comments: NO "Generated with Claude Code" footer, no Claude session links, no AI attribution of any kind
- Commit/PR author is the repo owner's git identity only; branch names read like a human engineer's (e.g. `feat/…`, `fix/…`), never AI-named

## Proxy Usage

The API key goes in the password field. The username carries hyphen-joined flags (`country-XX`, `class-residential|dc|mobile|masked`, `session-<id>`, `allowhttp-1`). `class-masked` (VPN/WARP/Tor egress, cheapest) is opt-in: unflagged requests never use masked nodes. With no flags, use `relay`.

```bash
# Any eligible node (HTTPS stays end-to-end TLS through the exit node):
curl -x http://relay:dn_live_KEY@localhost:8080 https://httpbin.org/ip

# US residential exit:
curl -x http://country-US-class-residential:dn_live_KEY@localhost:8080 https://httpbin.org/ip

# Sticky session on a datacenter exit, over SOCKS5:
curl -x socks5h://country-DE-class-dc-session-abc123:dn_live_KEY@localhost:1080 https://httpbin.org/ip

# Cheapest: anonymizer (VPN/WARP) exits, only when asked for:
curl -x http://class-masked:dn_live_KEY@localhost:8080 https://httpbin.org/ip

# Plain HTTP is rejected unless allowhttp-1 is set (the exit node can read it):
curl -x http://class-dc-allowhttp-1:dn_live_KEY@localhost:8080 http://httpbin.org/ip
```

## Current Status

Alpha. All packages compile. 2,436 tests pass across 154 test files in the root `npx vitest run`; integration and SDK suites run separately in their own toolchains.
