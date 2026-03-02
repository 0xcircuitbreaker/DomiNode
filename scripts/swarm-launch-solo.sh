#!/usr/bin/env bash
# ============================================================================
# Dominus Node Solo Swarm Launcher
# Launches N independent agents, each with its own account + wallet.
# Admin auto-assigns plans and credits wallets for each agent.
#
# Usage: ./swarm-launch-solo.sh [num_agents] [api_base] [proxy_host] [proxy_port]
#
# Environment:
#   ADMIN_EMAIL             — Admin email (required, no default)
#   ADMIN_PASSWORD          — Admin password (required)
#   SWARM_AGENT_CREDIT      — Cents per agent wallet (default: 500 = $5)
#   SWARM_AGENT_PLAN        — Plan for each agent (default: swarm-mixed)
#   SWARM_PASSWORD          — Shared password for agent accounts
#   SWARM_BATCH_SIZE        — Agents per batch (default: 25)
#   SWARM_BATCH_DELAY       — Seconds between batches (default: 10)
#   SWARM_POST_URLS         — Comma-separated social API endpoints
#   SWARM_POST_TOKENS       — Comma-separated auth tokens
#   SWARM_CYCLES            — Cycles per agent (default: 5)
#   SWARM_DELAY_SEC         — Delay between requests (default: 5)
#   SWARM_LOG_DIR           — Log directory (default: /tmp/dominusnode-swarm-solo)
# ============================================================================

set -euo pipefail

NUM_AGENTS="${1:-10}"
API_BASE="${2:-http://localhost:3000}"
PROXY_HOST="${3:-localhost}"
PROXY_PORT="${4:-8080}"

ADMIN_EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL required (set in .env.swarm or shell env)}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD required}"
BATCH_SIZE="${SWARM_BATCH_SIZE:-25}"
BATCH_DELAY="${SWARM_BATCH_DELAY:-10}"
LOG_DIR="${SWARM_LOG_DIR:-/tmp/dominusnode-swarm-solo}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_CREDIT="${SWARM_AGENT_CREDIT:-500}"
AGENT_PLAN="${SWARM_AGENT_PLAN:-swarm-mixed}"

export SWARM_PASSWORD="${SWARM_PASSWORD:-$(openssl rand -hex 16)}"

echo "============================================"
echo "  Dominus Node Solo Swarm Launcher"
echo "============================================"
echo ""
echo "  Model:        Solo (each agent = own account + wallet)"
echo "  Agents:       ${NUM_AGENTS}"
echo "  Plan:         ${AGENT_PLAN}"
echo "  Credit/agent: \$$(printf '%.2f' "$(echo "scale=2; ${AGENT_CREDIT}/100" | bc)")"
echo "  Total credit: \$$(printf '%.2f' "$(echo "scale=2; ${AGENT_CREDIT} * ${NUM_AGENTS} / 100" | bc)")"
echo "  Batch size:   ${BATCH_SIZE}"
echo "  API:          ${API_BASE}"
echo "  Proxy:        ${PROXY_HOST}:${PROXY_PORT}"
echo "  Log dir:      ${LOG_DIR}"
echo ""

# ─── Pre-flight checks ──────────────────────────────────────────────
echo "Pre-flight checks..."

API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/api/health" 2>/dev/null || echo "000")
if [ "$API_HEALTH" != "200" ]; then
  echo "ERROR: API not reachable (${API_HEALTH}). Start: npm run start:api"
  exit 1
fi
echo "  API:   OK"

PROXY_CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
  -x "http://test:test@${PROXY_HOST}:${PROXY_PORT}" \
  "http://httpbin.org/ip" 2>/dev/null || echo "000")
if [ "$PROXY_CHECK" = "000" ]; then
  echo "WARNING: Proxy not reachable at ${PROXY_HOST}:${PROXY_PORT}"
  read -p "  Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
else
  echo "  Proxy: OK (status ${PROXY_CHECK})"
fi

SLOTS=$(curl -s "${API_BASE}/api/slots" 2>/dev/null || echo '{"remaining":0}')
REMAINING=$(echo "$SLOTS" | grep -o '"remaining":[0-9]*' | cut -d: -f2)
echo "  Slots: ${REMAINING:-?} remaining"

if [ -n "$REMAINING" ] && [ "$REMAINING" -lt "$NUM_AGENTS" ]; then
  echo "WARNING: Only ${REMAINING} slots but requesting ${NUM_AGENTS} agents"
  read -p "  Continue? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi

echo ""

# ─── Admin auth ──────────────────────────────────────────────────────
# Pipe credentials via stdin to avoid exposure in process table
echo "Authenticating as admin..."
ADMIN_LOGIN=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" | \
  curl -s -X POST "${API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  --data @- 2>/dev/null || true)

export ADMIN_JWT
ADMIN_JWT=$(echo "$ADMIN_LOGIN" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$ADMIN_JWT" ]; then
  # Redact any potential token from error log
  echo "ERROR: Admin login failed. Response: $(echo "$ADMIN_LOGIN" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g')"
  exit 1
fi
echo "  Admin auth: OK"
echo ""

# ─── Launch agents ───────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
echo "$SWARM_PASSWORD" > "${LOG_DIR}/swarm-password.txt"
chmod 600 "${LOG_DIR}/swarm-password.txt"

# Clean up credential files on exit (normal or signal)
trap 'rm -f "${LOG_DIR}/swarm-password.txt" 2>/dev/null' EXIT

echo "Launching ${NUM_AGENTS} solo agents in batches of ${BATCH_SIZE}..."
echo "Logs: ${LOG_DIR}/agent-*.log"
echo ""

LAUNCHED=0
PIDS=()

for AGENT_NUM in $(seq 1 "$NUM_AGENTS"); do
  bash "${SCRIPT_DIR}/swarm-agent-solo.sh" "$AGENT_NUM" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT" \
    > "${LOG_DIR}/agent-${AGENT_NUM}.log" 2>&1 &
  PIDS+=($!)
  LAUNCHED=$((LAUNCHED + 1))

  echo -ne "\r  Launched ${LAUNCHED}/${NUM_AGENTS} agents..."

  if [ $((LAUNCHED % BATCH_SIZE)) -eq 0 ] && [ "$LAUNCHED" -lt "$NUM_AGENTS" ]; then
    echo ""
    echo "  Batch ${LAUNCHED} launched, waiting ${BATCH_DELAY}s..."
    sleep "$BATCH_DELAY"
  fi
done

echo ""
echo ""
echo "All ${NUM_AGENTS} solo agents launched!"

printf '%s\n' "${PIDS[@]}" > "${LOG_DIR}/pids.txt"

echo ""
echo "Monitor:"
echo "  tail -f ${LOG_DIR}/agent-*.log"
echo "  grep 'complete' ${LOG_DIR}/agent-*.log | wc -l"
echo "  grep 'ERROR' ${LOG_DIR}/agent-*.log"
echo ""
echo "Kill all:"
echo "  kill \$(cat ${LOG_DIR}/pids.txt)"
echo ""

# ─── Wait for completion ─────────────────────────────────────────────
echo "Waiting for agents to complete..."

COMPLETED=0
FAILED=0
for PID in "${PIDS[@]}"; do
  if wait "$PID" 2>/dev/null; then
    COMPLETED=$((COMPLETED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
  echo -ne "\r  Progress: $((COMPLETED + FAILED))/${NUM_AGENTS} (${COMPLETED} ok, ${FAILED} failed)"
done

echo ""
echo ""
echo "============================================"
echo "  Solo Swarm Complete"
echo "============================================"
echo "  Total:     ${NUM_AGENTS}"
echo "  Completed: ${COMPLETED}"
echo "  Failed:    ${FAILED}"
echo "  Logs:      ${LOG_DIR}/"
echo "============================================"

# Clean up credential files after swarm completes
rm -f "${LOG_DIR}/swarm-password.txt"
