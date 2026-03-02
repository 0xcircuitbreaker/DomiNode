#!/usr/bin/env bash
# ============================================================================
# Dominus Node Solo Swarm Agent
#
# A standalone agent that registers its own account, gets a personal API key,
# and runs proxy cycles independently (no team). Requires an admin to credit
# its wallet separately.
#
# Usage: ./swarm-agent-solo.sh <agent_num> <api_base> <proxy_host> <proxy_port>
#
# Environment:
#   ADMIN_JWT              — Admin JWT for wallet credit + plan assignment
#   SWARM_PASSWORD         — Shared password for agent accounts
#   SWARM_AGENT_CREDIT     — Cents to credit per agent (default: 500 = $5)
#   SWARM_AGENT_PLAN       — Plan to assign (default: swarm-mixed)
#   SWARM_SCRAPE_TARGETS   — Comma-separated URLs for residential scraping
#   SWARM_POST_URLS        — Comma-separated social API endpoints
#   SWARM_POST_TOKENS      — Comma-separated auth tokens
#   SWARM_RES_SCRAPES      — Residential scrapes per cycle (default: 1)
#   SWARM_DC_REQUESTS      — DC requests per cycle (default: 4)
#   SWARM_CYCLES           — Number of cycles (default: 5)
#   SWARM_DELAY_SEC        — Delay between requests (default: 5)
# ============================================================================

set -euo pipefail

AGENT_NUM="${1:?Usage: swarm-agent-solo.sh <agent_num> <api_base> <proxy_host> <proxy_port>}"
API_BASE="${2:-http://localhost:3000}"
PROXY_HOST="${3:-localhost}"
PROXY_PORT="${4:-8080}"

# Default password is hex-safe. Warn if custom password has JSON-unsafe chars.
PASSWORD="${SWARM_PASSWORD:-$(openssl rand -hex 16)}"
if echo "$PASSWORD" | grep -qE '["\\\n\r\t]'; then
  echo "[solo-${AGENT_NUM}] WARNING: SWARM_PASSWORD contains JSON-unsafe chars (quotes/backslashes). Use hex-only passwords." >&2
fi
AGENT_CREDIT="${SWARM_AGENT_CREDIT:-500}"
AGENT_PLAN="${SWARM_AGENT_PLAN:-swarm-mixed}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

EMAIL="swarm-solo-${AGENT_NUM}@dominusnode.bot"

log() { echo "[solo-${AGENT_NUM}] $(date '+%H:%M:%S') $*"; }

# ─── Step 1: Register ────────────────────────────────────────────────
# Pipe credentials via stdin (--data @-) to avoid exposure in process table
log "Registering as ${EMAIL}..."
REG_RESP=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD" | \
  curl -s -w "\n%{http_code}" -X POST "${API_BASE}/api/auth/register" \
  -H "Content-Type: application/json" \
  --data @- 2>/dev/null || true)
HTTP_CODE=$(echo "$REG_RESP" | tail -1)

if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  log "Registered"
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
  log "ERROR: Login failed. Response: $(echo "$LOGIN_RESP" | sed 's/"token":"[^"]*"/"token":"REDACTED"/g')"
  exit 1
fi
log "Logged in"

# ─── Step 3: Get user ID ─────────────────────────────────────────────
ME_RESP=$(curl -s -H "Authorization: Bearer ${TOKEN}" "${API_BASE}/api/auth/me" 2>/dev/null || true)
USER_ID=$(echo "$ME_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$USER_ID" ]; then
  log "ERROR: Could not get user ID"
  exit 1
fi
log "User ID: ${USER_ID}"

# ─── Step 4: Admin assigns plan + credits wallet ─────────────────────
if [ -n "${ADMIN_JWT:-}" ]; then
  # Assign plan
  PLAN_RESP=$(curl -s -w "\n%{http_code}" -X PUT "${API_BASE}/api/admin/users/${USER_ID}/plan" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    -d "{\"planId\":\"${AGENT_PLAN}\"}" 2>/dev/null || true)
  PLAN_CODE=$(echo "$PLAN_RESP" | tail -1)
  if [ "$PLAN_CODE" = "200" ]; then
    log "Plan assigned: ${AGENT_PLAN}"
  else
    log "Plan assignment returned ${PLAN_CODE} (may already be set)"
  fi

  # Credit wallet
  CREDIT_RESP=$(curl -s -w "\n%{http_code}" -X POST "${API_BASE}/api/admin/credit-wallet" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${ADMIN_JWT}" \
    -d "{\"targetUserId\":\"${USER_ID}\",\"amountCents\":${AGENT_CREDIT},\"reason\":\"Solo swarm agent #${AGENT_NUM}\"}" 2>/dev/null || true)
  CREDIT_CODE=$(echo "$CREDIT_RESP" | tail -1)
  if [ "$CREDIT_CODE" = "200" ]; then
    log "Wallet credited: \$$(printf '%.2f' "$(echo "scale=2; ${AGENT_CREDIT}/100" | bc)")"
  else
    log "Wallet credit returned ${CREDIT_CODE}"
  fi
else
  log "WARNING: No ADMIN_JWT set — cannot assign plan or credit wallet"
  log "Agent will use default plan and existing wallet balance"
fi

# ─── Step 5: Create API key ──────────────────────────────────────────
log "Creating API key..."
KEY_RESP=$(curl -s -X POST "${API_BASE}/api/keys" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"label\":\"solo-${AGENT_NUM}\"}" 2>/dev/null || true)

API_KEY=$(echo "$KEY_RESP" | grep -o '"rawKey":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$API_KEY" ]; then
  log "Key creation failed: ${KEY_RESP}"
  log "Attempting to use existing key..."
  # List keys and try to use the first one
  # (keys list doesn't show raw value — need a new one)
  log "ERROR: Cannot proceed without API key"
  exit 1
fi
log "API key ready: ${API_KEY:0:8}..."

# ─── Step 6: Delegate to swarm-agent.sh ──────────────────────────────
# Pass API key via environment variable instead of command-line argument
# (command-line args are visible in process table via ps aux)
log "Starting proxy cycles..."
export SWARM_API_KEY="$API_KEY"
exec bash "${SCRIPT_DIR}/swarm-agent.sh" "$AGENT_NUM" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT"
