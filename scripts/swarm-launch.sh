#!/usr/bin/env bash
# ============================================================================
# DomiNode Team Swarm Launcher
#
# Entry point that:
#   1. Pre-flight checks (API, proxy, slots)
#   2. Authenticates as admin to get ADMIN_JWT
#   3. Launches the main agent (which creates team + sub-agents internally)
#
# Usage: ./swarm-launch.sh [num_agents] [api_base] [proxy_host] [proxy_port]
# Example: ./swarm-launch.sh 200 http://localhost:3000 localhost 8080
#
# Environment:
#   ADMIN_EMAIL             — Admin email (required, no default)
#   ADMIN_PASSWORD          — Admin password (required)
#   SWARM_TEAM_CREDIT       — Cents to credit team wallet (default: 10000 = $100)
#   SWARM_BATCH_SIZE        — Sub-agents per batch (default: 25)
#   SWARM_BATCH_DELAY       — Seconds between batches (default: 10)
#   SWARM_PASSWORD          — Shared password for main agent account
#   SWARM_SCRAPE_TARGETS    — Comma-separated residential scrape URLs
#   SWARM_POST_URLS         — Comma-separated social API endpoints
#   SWARM_POST_TOKENS       — Comma-separated auth tokens
#   SWARM_RES_SCRAPES       — Residential scrapes per cycle per agent (default: 1)
#   SWARM_DC_REQUESTS       — DC requests per cycle per agent (default: 4)
#   SWARM_CYCLES            — Cycles per sub-agent (default: 5)
#   SWARM_DELAY_SEC         — Delay between requests (default: 5)
#   SWARM_LOG_DIR           — Log directory (default: /tmp/dominusnode-swarm)
# ============================================================================

set -euo pipefail

NUM_AGENTS="${1:-10}"
API_BASE="${2:-http://localhost:3000}"
PROXY_HOST="${3:-localhost}"
PROXY_PORT="${4:-8080}"

ADMIN_EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL required (set in .env.swarm or shell env)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD required}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SWARM_LOG_DIR:-/tmp/dominusnode-swarm}"

RES_SCRAPES="${SWARM_RES_SCRAPES:-1}"
DC_REQUESTS="${SWARM_DC_REQUESTS:-4}"
CYCLES="${SWARM_CYCLES:-5}"

# ─── Bandwidth estimation (residential conservation model) ────────────
# Per agent per run: RES_SCRAPES * CYCLES * ~100KB residential
#                  + DC_REQUESTS * CYCLES * ~5KB DC
RES_PER_AGENT_KB=$(( RES_SCRAPES * CYCLES * 100 ))
DC_PER_AGENT_KB=$(( DC_REQUESTS * CYCLES * 5 ))
TOTAL_RES_MB=$(( NUM_AGENTS * RES_PER_AGENT_KB / 1024 ))
TOTAL_DC_MB=$(( NUM_AGENTS * DC_PER_AGENT_KB / 1024 ))

echo "============================================"
echo "  DomiNode Team Swarm Launcher"
echo "============================================"
echo ""
echo "  Model:          Team-based (shared wallet, team API keys)"
echo "  Agents:         ${NUM_AGENTS} sub-agents"
echo "  Per agent:      ${CYCLES} cycles x (${RES_SCRAPES} res + ${DC_REQUESTS} DC)"
echo "  Batch size:     ${SWARM_BATCH_SIZE:-25}"
echo "  API:            ${API_BASE}"
echo "  Proxy:          ${PROXY_HOST}:${PROXY_PORT}"
echo "  Delay:          ${SWARM_DELAY_SEC:-5}s between requests"
echo "  Log dir:        ${LOG_DIR}"
echo ""
echo "  Estimated bandwidth:"
echo "    Residential:  ~${TOTAL_RES_MB} MB  (of 25 GB cap)"
echo "    DC:           ~${TOTAL_DC_MB} MB  (of 1 TB cap)"
echo ""

# Warn if residential estimate exceeds 70% of 25GB
RES_PCT=$(( TOTAL_RES_MB * 100 / 25600 ))
if [ "$RES_PCT" -gt 70 ]; then
  echo "  WARNING: Estimated residential usage is ${RES_PCT}% of 25GB cap!"
  echo "  Consider reducing agents, res scrapes/cycle, or cycles."
  echo ""
fi

# ─── Pre-flight checks ──────────────────────────────────────────────
echo "Pre-flight checks..."

# Check API is up
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/api/health" 2>/dev/null || echo "000")
if [ "$API_HEALTH" != "200" ]; then
  echo "ERROR: API not reachable at ${API_BASE}/api/health (got ${API_HEALTH})"
  echo "Start the API first: npm run start:api"
  exit 1
fi
echo "  API:   OK (${API_BASE})"

# Check proxy is up
PROXY_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
  -x "http://test:test@${PROXY_HOST}:${PROXY_PORT}" \
  "http://httpbin.org/ip" 2>/dev/null || echo "000")
if [ "$PROXY_CHECK" = "000" ]; then
  echo "WARNING: Proxy might not be reachable at ${PROXY_HOST}:${PROXY_PORT}"
  echo "  (got no response — start with: npm run start:proxy)"
  read -p "  Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
else
  echo "  Proxy: OK (${PROXY_HOST}:${PROXY_PORT}, status ${PROXY_CHECK})"
fi

# Check slots
SLOTS=$(curl -s "${API_BASE}/api/slots" 2>/dev/null || echo '{"remaining":0}')
REMAINING=$(echo "$SLOTS" | grep -o '"remaining":[0-9]*' | cut -d: -f2)
echo "  Slots: ${REMAINING:-?} remaining"

if [ -n "$REMAINING" ] && [ "$REMAINING" -lt 1 ]; then
  echo "WARNING: No slots available — main agent needs 1 slot"
  read -p "  Continue? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

# Check post URLs configured
if [ -z "${SWARM_POST_URLS:-}" ]; then
  echo "  Posts: NOT CONFIGURED (set SWARM_POST_URLS to enable posting)"
else
  IFS=',' read -ra _URLS <<< "$SWARM_POST_URLS"
  echo "  Posts: ${#_URLS[@]} platform(s) configured"
fi

echo ""

# ─── Authenticate as admin ───────────────────────────────────────────
# Pipe credentials via stdin to avoid exposure in process table
echo "Authenticating as admin (${ADMIN_EMAIL})..."
ADMIN_LOGIN=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" | \
  curl -s -X POST "${API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  --data @- 2>/dev/null || true)

ADMIN_JWT=$(echo "$ADMIN_LOGIN" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ADMIN_JWT" ]; then
  # Redact any potential token from error log
  echo "ERROR: Failed to get admin JWT. Response: $(echo "$ADMIN_LOGIN" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g')"
  exit 1
fi
echo "  Admin auth: OK"
echo ""

# ─── Launch main agent ───────────────────────────────────────────────
echo "Launching main agent (will create team + ${NUM_AGENTS} sub-agents)..."
echo "Logs: ${LOG_DIR}/"
echo ""

export ADMIN_JWT
export SWARM_PASSWORD="${SWARM_PASSWORD:-$(openssl rand -hex 16)}"
export SWARM_NUM_AGENTS="$NUM_AGENTS"

# Save password
mkdir -p "$LOG_DIR"
echo "$SWARM_PASSWORD" > "${LOG_DIR}/swarm-password.txt"
chmod 600 "${LOG_DIR}/swarm-password.txt"

# Clean up credential files on exit (normal or signal)
trap 'rm -f "${LOG_DIR}/swarm-password.txt" 2>/dev/null' EXIT

bash "${SCRIPT_DIR}/swarm-main-agent.sh" "$NUM_AGENTS" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT"
