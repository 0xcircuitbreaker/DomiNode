# Dominus Node — Integration Showcase Swarm

A multi-agent swarm script that **live-tests every AI framework integration** in
the Dominus Node ecosystem. Each agent spins up an ephemeral account, funds its
wallet, runs its assigned SDK through a real proxy request, and generates a
social post about the result.

Use it to:
- Validate all 24 integrations end-to-end against a real Dominus Node server
- Surface regressions before a release
- Collect integration health data for the dev team
- Generate demo content showing each framework working with Dominus Node

---

## Integrations Covered (25 total — 53 tools each)

Each integration exercises the **full DomiNode lifecycle**: account management,
API key operations, billing (Stripe/PayPal/crypto), proxy fetch with
geo-targeting, usage analytics, agentic wallet management (create/fund/freeze/
unfreeze/delete/policy), and complete team management (17 team operations
including invites, keys, members, roles).

| # | ID | Name | Runtime | Package | Tools |
|---|-----|------|---------|---------|-------|
| 1 | `langchain` | LangChain | Python | `dominusnode-langchain` | 53 |
| 2 | `crewai` | CrewAI | Python | `dominusnode-crewai` | 53 |
| 3 | `llamaindex` | LlamaIndex | Python | `dominusnode-llamaindex` | 53 |
| 4 | `autogpt` | AutoGPT | Python | `dominusnode-autogpt` | 53 |
| 5 | `agent-zero` | Agent Zero | Python | *(built-in)* | 53 |
| 6 | `superagi` | SuperAGI | Python | `dominusnode-superagi` | 53 |
| 7 | `agno` | Agno | Python | `dominusnode-agno` | 53 |
| 8 | `camel-ai` | CAMEL-AI | Python | `dominusnode-camel` | 53 |
| 9 | `composio` | Composio | Python | `dominusnode-composio` | 53 |
| 10 | `dify` | Dify | Python | `dominusnode-dify` | 53 |
| 11 | `haystack` | Haystack | Python | `dominusnode-haystack` | 53 |
| 12 | `ironclaw` | IronClaw | Python | `dominusnode-ironclaw` | 53 |
| 13 | `metagpt` | MetaGPT | Python | `dominusnode-metagpt` | 53 |
| 14 | `moltbook` | Moltbook | Python | `dominusnode-moltbook` | 53 |
| 15 | `pydantic-ai` | PydanticAI | Python | `dominusnode-pydanticai` | 53 |
| 16 | `semantic-kernel` | Semantic Kernel | Python | `dominusnode-semantic-kernel` | 53 |
| 17 | `raw-http` | Raw HTTP | Python | *(none)* | 53 |
| 18 | `mastra` | Mastra | Node.js | `@dominusnode/mastra-tools` | 53 |
| 19 | `flowise` | Flowise | Node.js | `@dominusnode/flowise-tools` | 53 |
| 20 | `openclaw` | OpenClaw | Node.js | *(local plugin)* | 53 |
| 21 | `vercel-ai` | Vercel AI | Node.js | `@dominusnode/ai-tools` | 53 |
| 22 | `openai-functions` | OpenAI Functions | Node.js | *(local handler)* | 53 |
| 23 | `n8n` | n8n | Node.js | `n8n-nodes-dominusnode` | 53 |
| 24 | `gemini` | Gemini/Vertex AI | Node.js | `@dominusnode/gemini-functions` | 53 |
| 25 | `pi` | Pi (pi-mono) | Node.js | `@dominusnode/pi-extension` | 53 |

---

## Prerequisites

### Required
- **Python 3.9+** — the swarm launcher itself
- **Dominus Node server** running locally (or set `DOMINUSNODE_BASE_URL`)
  - REST API on `:3000`
  - HTTP proxy on `:8080`
  - Admin account credentials

### For Node.js integrations (mastra, flowise, openclaw, vercel-ai, openai-functions, n8n, gemini)
- **Node.js ≥ 18** — check with `node --version`
- **npm** — check with `npm --version`

### Python framework packages
**Automatic** — the swarm creates an isolated `.showcase-venv/` virtualenv on
first run and installs all Python dependencies there. No manual `pip install`
needed; your system Python stays untouched.

To force a clean venv, delete it and re-run:
```bash
rm -rf .showcase-venv
python3 scripts/swarm-showcase.py
```

### Node.js integration builds
Build all TypeScript integrations (required before first run):

```bash
for pkg in mastra flowise openclaw vercel-ai openai-functions n8n gemini; do
  echo "Building $pkg..."
  (cd integrations/$pkg && npm install --silent && npm run build --silent)
done
```

Or let the swarm's **pre-launch screen** do it for you (press `I` to install
all missing dependencies before launching).

---

## Quick Start

### Interactive TUI (recommended)

```bash
# Set env vars (or enter via TUI)
export ADMIN_EMAIL="admin@example.com"
export ADMIN_PASSWORD="your-admin-password"

python3 scripts/swarm-showcase.py
```

The TUI walks you through 4 screens:
1. **Connection** — set API base URL, proxy host/port, admin credentials
2. **Select integrations** — toggle which of the 24 integrations to test
3. **Agent distribution** — set total agents, agents per integration, budget
4. **Pre-launch** — dependency check + auto-install; press I to fix missing

### Non-interactive (CI/scripting)

```bash
# Test all 24 integrations, 2 agents each
python3 scripts/swarm-showcase.py \
  --no-tui \
  --api-base http://localhost:3000 \
  --proxy-host localhost \
  --proxy-port 8080 \
  --agents 48 \
  --per-integration 2 \
  --target-url https://httpbin.org/ip

# Test specific integrations only
python3 scripts/swarm-showcase.py \
  --no-tui \
  --integrations langchain crewai agno pydantic-ai gemini \
  --agents 10 \
  --per-integration 2

# Quick smoke test — 3 fast integrations
python3 scripts/swarm-showcase.py \
  --no-tui \
  --integrations raw-http openai-functions langchain \
  --agents 3 \
  --per-integration 1
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_EMAIL` | *(required)* | Admin account email |
| `ADMIN_PASSWORD` | *(required)* | Admin account password |
| `DOMINUSNODE_BASE_URL` | `http://localhost:3000` | REST API base URL |
| `DOMINUSNODE_PROXY_HOST` | `localhost` | Proxy gateway host |
| `DOMINUSNODE_PROXY_PORT` | `8080` | Proxy gateway port |

---

## How It Works

### Per-agent lifecycle

```
1. Register ephemeral account  →  showcase-<integ>-<hex>@dominusnode.bot
2. Admin credits wallet        →  200¢ ($2.00) default
3. Create API key              →  dn_live_... (shown once)
4. Run integration             →  check_balance + proxied_fetch (+ check_usage)
5. Generate social post        →  from template, formatted with real results
6. Record result               →  success/failure + bytes + duration
```

### Concurrency

All agents run concurrently via `ThreadPoolExecutor(max_workers=20)`. Node.js
integrations run as subprocesses (`swarm-showcase-node-runner.js`) to avoid
Python/Node interop overhead.

### Node.js bridge

`swarm-showcase-node-runner.js` handles all TypeScript integrations. It:
- Receives integration ID + connection params via argv (API key via `SHOWCASE_API_KEY` env)
- Validates all inputs (URL schemes, hostname regex, proxy_type whitelist)
- Scrubs all output of `dn_live_*` / `dn_test_*` credentials
- Enforces a 30s hard timeout
- Returns a single JSON object `{balance?, fetch?, usage?, error?}`

---

## Output

### Live console

```
  ✓  Agent #1  [LangChain     ]  done      fetch:287B
  ✓  Agent #2  [CrewAI        ]  done      fetch:291B
  ✗  Agent #3  [Dify          ]  failed    ERR:Connection refused
  ✓  Agent #4  [Gemini        ]  done      fetch:289B
```

### Per-integration summary

```
  LangChain           2/2 ok  bal:✓  fetch:✓
  CrewAI              2/2 ok  bal:✓  fetch:✓
  Dify                0/2 ok  bal:✗  fetch:✗
  Gemini              2/2 ok  bal:✓  fetch:✓
```

### Generated social posts

Each successful agent generates a framework-specific social post (≤280 chars)
using the real target URL and elapsed time from the run.

### JSON export

Results saved to `/tmp/dominusnode-showcase/results.json` (mode 0600):

```json
{
  "config": { "integrations": [...], "total_agents": 48, ... },
  "results": [
    { "agent": 1, "integration": "langchain", "success": true,
      "balance": true, "fetch": true, "fetch_bytes": 287,
      "duration": 1.23, "error": "", "post": "..." },
    ...
  ],
  "posts": ["...", "..."]
}
```

---

## Integration Notes

### Python integrations

Most Python integrations follow this pattern:
```python
DominusNodeToolkit(api_key=..., base_url=..., proxy_host=..., proxy_port=...)
toolkit.check_balance()
toolkit.proxied_fetch(url=..., country="US", proxy_type="dc")
```

Exceptions:
- **Dify**: `DominusNodeProvider(credentials={...})` — params via dict, methods return `Dict`
- **Semantic Kernel**: Class is `DominusNodePlugin`, not `DominusNodeToolkit`
- **Moltbook**: `MoltbookClient(dominusnode_api_key=..., ...)` — wallet ops require Ethereum signing
- **Agent Zero**: No installable package — tools loaded via `importlib.util` from numbered files (`01_proxy_fetch.py`, `02_wallet.py`)
- **SuperAGI**: No-arg `DominusNodeToolkit()` constructor — reads all config from environment variables

### Node.js integrations

| Integration | Module type | Entry point |
|------------|-------------|-------------|
| mastra | CJS | `dist/index.js` |
| flowise | CJS | `dist/index.js` |
| openai-functions | CJS | `dist/handler.js` |
| n8n | CJS (auth only) | `dist/shared/auth.js` |
| openclaw | ESM | `dist/plugin.js` |
| vercel-ai | ESM | `dist/index.js` |
| gemini | ESM | `dist/handler.js` |

---

## Troubleshooting

### "node not found"
Install Node.js ≥18 from https://nodejs.org or via your system package manager.

### "pip install -e failed"
Check that the integration source directory exists:
```bash
ls integrations/<name>/
```
For missing framework deps, delete the venv and retry:
```bash
rm -rf .showcase-venv
python3 scripts/swarm-showcase.py
```

### Venv creation fails
Ensure `python3 -m venv` works on your system. On Debian/Ubuntu you may need:
```bash
sudo apt install python3-venv
```

### Stale venv (wrong Python version, broken packages)
```bash
rm -rf .showcase-venv
python3 scripts/swarm-showcase.py
```

### "Failed to obtain API key"
The admin credentials are wrong, or the Dominus Node server isn't running.
Check: `curl http://localhost:3000/api/health`

### "Runner timed out after 30s"
The proxy gateway or upstream Webshare proxy is slow. Try `--proxy-type dc` (faster
than residential) and ensure the proxy gateway is running on `:8080`.

### "DOMINUSNODE_API_KEY must start with dn_live_ or dn_test_"
The account registration succeeded but API key creation failed. Check that the
admin can credit wallets and the user hit the key creation endpoint correctly.

---

## Files

```
scripts/
├── swarm-showcase.py              # Main launcher (Python, curses TUI + ANSI output)
├── swarm-showcase-node-runner.js  # Node.js bridge for TypeScript integrations
├── requirements-swarm-showcase.txt  # Python framework deps for pip pre-install
└── README-swarm-showcase.md       # This file
```
