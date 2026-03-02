#!/usr/bin/env bash
# ============================================================================
# Dominus Node Team Swarm — Main Agent (Orchestrator)
#
# The main agent:
#   1. Registers its own account + logs in
#   2. Creates a team ("Dominus Node Agent Swarm")
#   3. Gets the team wallet credited by the admin
#   4. Creates N team API keys (one per sub-agent)
#   5. Launches N sub-agents in parallel, each with a team key
#   6. Waits for completion and posts a summary
#
# Usage: ./swarm-main-agent.sh <num_agents> <api_base> <proxy_host> <proxy_port>
#
# Environment:
#   ADMIN_JWT              — JWT for admin account (required, for wallet credit)
#   SWARM_PASSWORD         — Shared password for main agent account
#   SWARM_TEAM_CREDIT      — Cents to credit the team wallet (default: 10000 = $100)
#   SWARM_BATCH_SIZE       — Sub-agents per batch (default: 25)
#   SWARM_BATCH_DELAY      — Seconds between batches (default: 10)
#   SWARM_SCRAPE_TARGETS   — Comma-separated URLs for residential scraping
#   SWARM_POST_URLS        — Comma-separated social API endpoints
#   SWARM_POST_TOKENS      — Comma-separated auth tokens
#   SWARM_CYCLES           — Cycles per sub-agent (default: 5)
#   SWARM_DELAY_SEC        — Delay between requests (default: 5)
#   SWARM_LOG_DIR          — Log directory (default: /tmp/dominusnode-swarm)
# ============================================================================

set -euo pipefail

NUM_AGENTS="${1:?Usage: swarm-main-agent.sh <num_agents> <api_base> <proxy_host> <proxy_port>}"
API_BASE="${2:-http://localhost:3000}"
PROXY_HOST="${3:-localhost}"
PROXY_PORT="${4:-8080}"

ADMIN_JWT="${ADMIN_JWT:?ADMIN_JWT required — login as admin first}"
LOG_DIR="${SWARM_LOG_DIR:-/tmp/dominusnode-swarm}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASSWORD="${SWARM_PASSWORD:-$(openssl rand -hex 16)}"

# ─── Validate numeric env vars (C-3) ─────────────────────────────────
validate_int() {
  local name="$1" value="$2" default="$3" min="${4:-1}" max="${5:-100000}"
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    echo "WARNING: ${name} is not a valid integer ('${value}'), using default ${default}" >&2
    echo "$default"; return
  fi
  if [ "$value" -lt "$min" ]; then value="$min"; fi
  if [ "$value" -gt "$max" ]; then value="$max"; fi
  echo "$value"
}

TEAM_CREDIT=$(validate_int "SWARM_TEAM_CREDIT" "${SWARM_TEAM_CREDIT:-10000}" 10000 1 1000000)
BATCH_SIZE=$(validate_int "SWARM_BATCH_SIZE" "${SWARM_BATCH_SIZE:-25}" 25 1 100)
BATCH_DELAY=$(validate_int "SWARM_BATCH_DELAY" "${SWARM_BATCH_DELAY:-10}" 10 1 300)

if ! [[ "$NUM_AGENTS" =~ ^[0-9]+$ ]] || [ "$NUM_AGENTS" -lt 1 ] || [ "$NUM_AGENTS" -gt 1000 ]; then
  echo "ERROR: num_agents must be 1-1000 (got: $NUM_AGENTS)"; exit 1
fi

(umask 077 && mkdir -p "$LOG_DIR")

# Clean up child processes + credential files on exit
PIDS=()
cleanup() {
  rm -f "${LOG_DIR}/team-keys.txt" 2>/dev/null
  if [ ${#PIDS[@]} -gt 0 ]; then
    for PID in "${PIDS[@]}"; do kill "$PID" 2>/dev/null || true; done
    sleep 1
    for PID in "${PIDS[@]}"; do kill -9 "$PID" 2>/dev/null || true; done
  fi
}
trap cleanup EXIT INT TERM

log() { echo "[main-agent] $(date '+%H:%M:%S') $*"; }

# ─── Step 1: Register main agent account ─────────────────────────────
EMAIL="swarm-main-agent@dominusnode.bot"
log "Registering main agent as ${EMAIL}..."

# Pipe credentials via stdin to avoid exposure in process table
REG_RESP=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD" | \
  curl -s -w "\n%{http_code}" -X POST "${API_BASE}/api/auth/register" \
  -H "Content-Type: application/json" \
  --data @- 2>/dev/null || true)
HTTP_CODE=$(echo "$REG_RESP" | tail -1)

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  log "Registered successfully"
else
  log "Registration returned ${HTTP_CODE} (may already exist)"
fi

# ─── Step 2: Login ───────────────────────────────────────────────────
# Pipe credentials via stdin
log "Logging in..."
LOGIN_RESP=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD" | \
  curl -s -X POST "${API_BASE}/api/auth/login" \
  -H "Content-Type: application/json" \
  --data @- 2>/dev/null || true)

TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  # Redact any potential token from error log
  log "ERROR: Failed to get JWT. Response: $(echo "$LOGIN_RESP" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g')"
  exit 1
fi
log "Logged in"

# ─── Step 3: Create team ─────────────────────────────────────────────
log "Creating team 'Dominus Node Agent Swarm'..."
TEAM_RESP=$(printf '{"name":"Dominus Node Agent Swarm","maxMembers":%d}' "$NUM_AGENTS" | \
  curl -s -X POST "${API_BASE}/api/teams" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  --data @- 2>/dev/null || true)

TEAM_ID=$(echo "$TEAM_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TEAM_ID" ]; then
  # Team may already exist — try listing
  log "Team creation response: ${TEAM_RESP}"
  TEAMS_LIST=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API_BASE}/api/teams" 2>/dev/null || true)
  TEAM_ID=$(echo "$TEAMS_LIST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$TEAM_ID" ]; then
    log "ERROR: Cannot create or find team"
    exit 1
  fi
  log "Using existing team: ${TEAM_ID}"
else
  log "Team created: ${TEAM_ID}"
fi

# ─── Step 4: Credit team wallet (admin operation) ────────────────────
# Validate TEAM_ID is UUID-like (C-4: prevent JSON/path injection)
if ! [[ "$TEAM_ID" =~ ^[a-f0-9-]+$ ]]; then
  log "ERROR: Invalid team ID format: ${TEAM_ID}"
  exit 1
fi
log "Crediting team wallet with \$$(( TEAM_CREDIT / 100 )).$(printf '%02d' $(( TEAM_CREDIT % 100 )))..."
CREDIT_RESP=$(printf '{"teamId":"%s","amountCents":%d,"reason":"Swarm launch credit"}' "$TEAM_ID" "$TEAM_CREDIT" | \
  curl -s -w "\n%{http_code}" -X POST "${API_BASE}/api/admin/credit-wallet" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ADMIN_JWT}" \
  --data @- 2>/dev/null || true)
CREDIT_CODE=$(echo "$CREDIT_RESP" | tail -1)
CREDIT_BODY=$(echo "$CREDIT_RESP" | sed '$d')

if [ "$CREDIT_CODE" = "200" ]; then
  log "Team wallet credited"
else
  log "WARNING: Credit returned ${CREDIT_CODE}: ${CREDIT_BODY}"
  log "Continuing — team wallet may already have funds"
fi

# ─── Step 5: Create team API keys ────────────────────────────────────
log "Creating ${NUM_AGENTS} team API keys..."
KEYS_FILE="${LOG_DIR}/team-keys.txt"
> "$KEYS_FILE"
chmod 600 "$KEYS_FILE"

for i in $(seq 1 "$NUM_AGENTS"); do
  KEY_RESP=$(curl -s -X POST "${API_BASE}/api/teams/${TEAM_ID}/keys" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "{\"label\":\"swarm-sub-${i}\"}" 2>/dev/null || true)

  RAW_KEY=$(echo "$KEY_RESP" | grep -o '"rawKey":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$RAW_KEY" ]; then
    log "WARNING: Failed to create key #${i}: ${KEY_RESP}"
    echo "FAILED" >> "$KEYS_FILE"
  else
    echo "$RAW_KEY" >> "$KEYS_FILE"
  fi

  # Brief pause to avoid rate limiting
  if [ $((i % 10)) -eq 0 ]; then
    sleep 1
  fi
done

KEY_COUNT=$(grep -c -v "FAILED" "$KEYS_FILE" || true)
log "Created ${KEY_COUNT}/${NUM_AGENTS} team API keys"

if [ "$KEY_COUNT" -eq 0 ]; then
  log "ERROR: No API keys created, cannot launch sub-agents"
  exit 1
fi

# ─── Step 6: Launch sub-agents ───────────────────────────────────────
# Sub-agents don't need admin privileges — unset to limit blast radius (C-1)
unset ADMIN_JWT

log "Launching ${KEY_COUNT} sub-agents in batches of ${BATCH_SIZE}..."

LAUNCHED=0
AGENT_NUM=0

while IFS= read -r KEY; do
  if [ "$KEY" = "FAILED" ]; then
    continue
  fi
  AGENT_NUM=$((AGENT_NUM + 1))

  # Pass API key via env var instead of command-line arg (process table exposure)
  SWARM_API_KEY="$KEY" bash "${SCRIPT_DIR}/swarm-agent.sh" "$AGENT_NUM" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT" \
    > "${LOG_DIR}/agent-${AGENT_NUM}.log" 2>&1 &
  PIDS+=($!)
  LAUNCHED=$((LAUNCHED + 1))

  echo -ne "\r  Launched ${LAUNCHED}/${KEY_COUNT} sub-agents..."

  # Batch throttle
  if [ $((LAUNCHED % BATCH_SIZE)) -eq 0 ] && [ "$LAUNCHED" -lt "$KEY_COUNT" ]; then
    echo ""
    log "  Batch ${LAUNCHED} launched, waiting ${BATCH_DELAY}s..."
    sleep "$BATCH_DELAY"
  fi
done < "$KEYS_FILE"

echo ""
log "All ${LAUNCHED} sub-agents launched"

# Save PIDs for external kill
printf '%s\n' "${PIDS[@]}" > "${LOG_DIR}/pids.txt"

# ─── Step 7: Wait for completion ─────────────────────────────────────
log "Waiting for sub-agents to complete..."

COMPLETED=0
FAILED=0
for PID in "${PIDS[@]}"; do
  if wait "$PID" 2>/dev/null; then
    COMPLETED=$((COMPLETED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
  echo -ne "\r  Progress: $((COMPLETED + FAILED))/${LAUNCHED} (${COMPLETED} ok, ${FAILED} failed)"
done

echo ""
echo ""

# ─── Step 8: Summary ─────────────────────────────────────────────────
log "============================================"
log "  Team Swarm Complete"
log "============================================"
log "  Team:       ${TEAM_ID}"
log "  Agents:     ${LAUNCHED}"
log "  Completed:  ${COMPLETED}"
log "  Failed:     ${FAILED}"
log "  Logs:       ${LOG_DIR}/"
log "============================================"

# Clean up sensitive files
rm -f "$KEYS_FILE"
