#!/usr/bin/env bash
# ============================================================================
# Dominus Node Team Swarm — Sub-Agent
#
# Each sub-agent receives a team API key (no registration/login needed).
# Smart per-request pool routing conserves residential bandwidth:
#   - residential-country-US ONLY for: google.com, linkedin.com, indeed.com, glassdoor.com
#   - dc-country-US for everything else: API posts, testing, health checks
#
# Usage:
#   ./swarm-agent.sh <agent_num> <api_base> <proxy_host> <proxy_port> <team_api_key>
#
# Environment:
#   SWARM_SCRAPE_TARGETS   — Comma-separated URLs to scrape
#   SWARM_POST_URLS        — Comma-separated social API endpoints
#   SWARM_POST_TOKENS      — Comma-separated auth tokens
#   SWARM_RES_SCRAPES      — Residential scrapes per cycle (default: 1)
#   SWARM_DC_REQUESTS      — DC requests per cycle (default: 4)
#   SWARM_CYCLES           — Number of cycles (default: 5)
#   SWARM_DELAY_SEC        — Delay between requests (default: 5)
# ============================================================================

set -euo pipefail

AGENT_NUM="${1:?Usage: swarm-agent.sh <agent_num> <api_base> <proxy_host> <proxy_port> [team_api_key]}"
API_BASE="${2:-http://localhost:3000}"
PROXY_HOST="${3:-localhost}"
PROXY_PORT="${4:-8080}"
# Accept API key from env var (preferred) or arg $5 (legacy)
# Env var avoids process table credential exposure
API_KEY="${SWARM_API_KEY:-${5:-}}"
if [ -z "$API_KEY" ]; then
  echo "ERROR: API key required. Set SWARM_API_KEY env var or pass as arg 5."
  exit 1
fi

DELAY="${SWARM_DELAY_SEC:-5}"
RES_SCRAPES="${SWARM_RES_SCRAPES:-1}"
DC_REQUESTS="${SWARM_DC_REQUESTS:-4}"
CYCLES="${SWARM_CYCLES:-5}"

# Counters
TOTAL_RES_REQS=0
TOTAL_DC_REQS=0
TOTAL_RES_BYTES=0
TOTAL_DC_BYTES=0

log() { echo "[agent-${AGENT_NUM}] $(date '+%H:%M:%S') $*"; }

# ─── Smart pool routing ──────────────────────────────────────────────
# Only these domains use residential (they block datacenter IPs aggressively)
RESIDENTIAL_DOMAINS="google.com|linkedin.com|indeed.com|glassdoor.com"

choose_pool() {
  local url="$1"
  local host
  host=$(echo "$url" | sed -E 's|https?://([^/:]+).*|\1|')

  if echo "$host" | grep -qE "(${RESIDENTIAL_DOMAINS})$"; then
    echo "residential-country-US"
  else
    echo "dc-country-US"
  fi
}

proxy_url() {
  local pool="$1"
  echo "http://${pool}:${API_KEY}@${PROXY_HOST}:${PROXY_PORT}"
}

# ─── Default targets ─────────────────────────────────────────────────
# Residential targets: sites that block DC IPs
DEFAULT_RES_TARGETS="https://www.google.com/search?q=dominusnode+proxy+api"
IFS=',' read -ra RES_TARGETS <<< "${SWARM_SCRAPE_TARGETS:-$DEFAULT_RES_TARGETS}"

# DC targets: APIs and test endpoints (cheap, no DC blocking)
DC_TARGETS=(
  "https://httpbin.org/ip"
  "https://httpbin.org/headers"
  "https://httpbin.org/get"
  "https://httpbin.org/status/200"
)

# Post URLs (all via DC)
IFS=',' read -ra POST_URLS <<< "${SWARM_POST_URLS:-}"
IFS=',' read -ra POST_TOKENS <<< "${SWARM_POST_TOKENS:-}"

# ─── Message templates (agent-swarm targeted) ────────────────────────
TEMPLATES=(
  "Team agent #AGENT running on Dominus Node shared billing. RES_REQS residential + DC_REQS DC requests. RESBW res, DCBW DC. Team wallets, per-key budgets, zero per-agent signup. #AgentInfra #DominusNode"
  "Swarm sub-agent #AGENT: team key auth, shared wallet billing. Smart routing: residential for Google/LinkedIn only, DC for everything else. TOTALBW total. npm i @dominusnode/sdk #AIProxy"
  "Agent #AGENT completed CYCLES cycles. Team billing = one wallet for the whole swarm. RES_REQS residential lookups + DC_REQS DC API calls. SDKs: Node, Python, Rust, Go, Java, C++. #DominusNode"
  "Running as part of a AGENTS-agent swarm on Dominus Node. Team key = no signup per agent. Smart pool routing saves 80% residential bandwidth. TOTALBW total. dominusnode.com #AgentSwarm"
)

make_post_body() {
  local template_idx=$(( RANDOM % ${#TEMPLATES[@]} ))
  local msg="${TEMPLATES[$template_idx]}"
  local res_kb=$(( TOTAL_RES_BYTES / 1024 ))
  local dc_kb=$(( TOTAL_DC_BYTES / 1024 ))
  local total_kb=$(( (TOTAL_RES_BYTES + TOTAL_DC_BYTES) / 1024 ))

  msg="${msg//AGENT/${AGENT_NUM}}"
  msg="${msg//RES_REQS/${TOTAL_RES_REQS}}"
  msg="${msg//DC_REQS/${TOTAL_DC_REQS}}"
  msg="${msg//CYCLES/${CYCLE}}"
  msg="${msg//RESBW/${res_kb}KB}"
  msg="${msg//DCBW/${dc_kb}KB}"
  msg="${msg//TOTALBW/${total_kb}KB}"
  msg="${msg//AGENTS/${SWARM_NUM_AGENTS:-?}}"

  echo "{\"content\":\"${msg}\",\"visibility\":\"public\"}"
}

do_request() {
  local url="$1"
  local pool
  pool=$(choose_pool "$url")
  local proxy
  proxy=$(proxy_url "$pool")

  local resp
  resp=$(curl -s -o /dev/null -w "%{http_code}|%{size_download}|%{time_total}" \
    -x "$proxy" \
    -H "User-Agent: DominusNode-Agent/${AGENT_NUM}" \
    --connect-timeout 30 \
    --max-time 60 \
    "$url" 2>/dev/null || echo "000|0|0")

  local status bytes time_s
  status=$(echo "$resp" | cut -d'|' -f1)
  bytes=$(echo "$resp" | cut -d'|' -f2)
  time_s=$(echo "$resp" | cut -d'|' -f3)

  if [[ "$pool" == residential-* ]]; then
    TOTAL_RES_REQS=$((TOTAL_RES_REQS + 1))
    TOTAL_RES_BYTES=$((TOTAL_RES_BYTES + bytes))
    log "  [res] ${url} -> ${status} (${bytes}B, ${time_s}s)"
  else
    TOTAL_DC_REQS=$((TOTAL_DC_REQS + 1))
    TOTAL_DC_BYTES=$((TOTAL_DC_BYTES + bytes))
    log "  [dc]  ${url} -> ${status} (${bytes}B, ${time_s}s)"
  fi

  echo "$status"
}

# ─── Main loop ───────────────────────────────────────────────────────
log "Starting ${CYCLES} cycles (${RES_SCRAPES} res + ${DC_REQUESTS} DC per cycle, ${DELAY}s delay)"
# Only log key prefix (8 chars) to avoid credential leakage in log files
log "API key: ${API_KEY:0:8}..."

for CYCLE in $(seq 1 "$CYCLES"); do
  log "── Cycle ${CYCLE}/${CYCLES} ──"

  # ── Phase A: Residential scrapes (limited) ──────────────────────
  for s in $(seq 1 "$RES_SCRAPES"); do
    TARGET_IDX=$(( (TOTAL_RES_REQS) % ${#RES_TARGETS[@]} ))
    TARGET="${RES_TARGETS[$TARGET_IDX]}"

    STATUS=$(do_request "$TARGET")

    if [ "$STATUS" = "403" ] || [ "$STATUS" = "402" ]; then
      log "  Residential limit hit (${STATUS}), skipping remaining"
      break
    fi

    sleep "$DELAY"
  done

  # ── Phase B: DC requests (cheap, high volume) ──────────────────
  for d in $(seq 1 "$DC_REQUESTS"); do
    TARGET_IDX=$(( (TOTAL_DC_REQS) % ${#DC_TARGETS[@]} ))
    TARGET="${DC_TARGETS[$TARGET_IDX]}"

    do_request "$TARGET" > /dev/null
    sleep "$DELAY"
  done

  # ── Phase C: Post about it (via DC) ────────────────────────────
  if [ ${#POST_URLS[@]} -gt 0 ]; then
    URL_IDX=$(( CYCLE % ${#POST_URLS[@]} ))
    POST_URL="${POST_URLS[$URL_IDX]}"
    POST_TOKEN="${POST_TOKENS[$URL_IDX]:-}"
    POST_BODY=$(make_post_body)

    RESP=$(curl -s -o /dev/null -w "%{http_code}|%{size_download}" \
      -x "$(proxy_url "dc-country-US")" \
      -X POST "$POST_URL" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${POST_TOKEN}" \
      -d "$POST_BODY" \
      --connect-timeout 30 \
      --max-time 60 2>/dev/null || echo "000|0")

    STATUS=$(echo "$RESP" | cut -d'|' -f1)
    BYTES=$(echo "$RESP" | cut -d'|' -f2)
    TOTAL_DC_REQS=$((TOTAL_DC_REQS + 1))
    TOTAL_DC_BYTES=$((TOTAL_DC_BYTES + BYTES))
    log "  [dc post] ${POST_URL} -> ${STATUS}"
  fi

  log "  Cycle ${CYCLE} done (res: ${TOTAL_RES_REQS} reqs, dc: ${TOTAL_DC_REQS} reqs)"
done

# ─── Final summary ──────────────────────────────────────────────────
RES_KB=$((TOTAL_RES_BYTES / 1024))
DC_KB=$((TOTAL_DC_BYTES / 1024))
TOTAL_KB=$(( (TOTAL_RES_BYTES + TOTAL_DC_BYTES) / 1024 ))

log "============================================"
log "Agent #${AGENT_NUM} complete (team key)"
log "  Cycles:        ${CYCLES}"
log "  Residential:   ${TOTAL_RES_REQS} reqs (${RES_KB}KB)"
log "  DC:            ${TOTAL_DC_REQS} reqs (${DC_KB}KB)"
log "  Total BW:      ${TOTAL_KB}KB"
log "============================================"
