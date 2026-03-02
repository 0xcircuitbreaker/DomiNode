#!/usr/bin/env bash
# ============================================================================
# Dominus Node Unified Swarm Launcher
#
# Loads config from .env.swarm (if present), then launches team mode,
# solo mode, or both simultaneously.
#
# Usage:
#   ./scripts/swarm.sh <num_agents> [team|solo|both]
#
# Examples:
#   ./scripts/swarm.sh 200          # both: 140 team + 60 solo
#   ./scripts/swarm.sh 50 team      # 50 team agents only
#   ./scripts/swarm.sh 50 solo      # 50 solo agents only
#   ./scripts/swarm.sh 200 both     # 140 team + 60 solo
#
# Environment:
#   Config is read from .env.swarm (next to this script's repo root).
#   All SWARM_* and ADMIN_* vars can also be set via shell env (overrides file).
#   See .env.swarm.example for the full reference.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Load .env.swarm if it exists (shell env takes precedence) ─────
ENV_FILE="${REPO_ROOT}/.env.swarm"
if [ -f "$ENV_FILE" ]; then
  echo "Loading config from ${ENV_FILE}"
  # Export each non-comment, non-empty line — only if not already set in env
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Trim whitespace with parameter expansion (no xargs — avoids command injection)
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # Validate key is a safe env var name
    if ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "WARNING: Skipping invalid env key: $key" >&2
      continue
    fi
    # Only set if not already in environment
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$ENV_FILE"
fi

# ─── Arguments ─────────────────────────────────────────────────────
NUM_AGENTS="${1:?Usage: swarm.sh <num_agents> [team|solo|both]}"
MODE="${2:-both}"

# Validate mode
case "$MODE" in
  team|solo|both) ;;
  *)
    echo "ERROR: Invalid mode '$MODE'. Must be: team, solo, or both"
    exit 1
    ;;
esac

# Validate num_agents is a positive integer
if ! [[ "$NUM_AGENTS" =~ ^[0-9]+$ ]] || [ "$NUM_AGENTS" -lt 1 ]; then
  echo "ERROR: num_agents must be a positive integer (got: $NUM_AGENTS)"
  exit 1
fi

# ─── Required check ───────────────────────────────────────────────
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required. Set in .env.swarm or shell env.}"

# ─── Inherit defaults from .env.swarm or use hardcoded fallbacks ──
export API_BASE="${API_BASE:-http://localhost:3000}"
export PROXY_HOST="${PROXY_HOST:-localhost}"
export PROXY_PORT="${PROXY_PORT:-8080}"
export SWARM_LOG_DIR="${SWARM_LOG_DIR:-/tmp/dominusnode-swarm}"

echo "============================================"
echo "  Dominus Node Unified Swarm Launcher"
echo "============================================"
echo ""
echo "  Mode:    ${MODE}"
echo "  Agents:  ${NUM_AGENTS}"
echo "  API:     ${API_BASE}"
echo "  Proxy:   ${PROXY_HOST}:${PROXY_PORT}"
echo "  Log dir: ${SWARM_LOG_DIR}"
echo ""

# ─── Calculate agent split for "both" mode ─────────────────────────
TEAM_AGENTS=0
SOLO_AGENTS=0

case "$MODE" in
  team)
    TEAM_AGENTS="$NUM_AGENTS"
    ;;
  solo)
    SOLO_AGENTS="$NUM_AGENTS"
    ;;
  both)
    # 70% team, 30% solo (minimum 1 each if total >= 2)
    TEAM_AGENTS=$(( NUM_AGENTS * 70 / 100 ))
    SOLO_AGENTS=$(( NUM_AGENTS - TEAM_AGENTS ))
    if [ "$TEAM_AGENTS" -lt 1 ] && [ "$NUM_AGENTS" -ge 1 ]; then
      TEAM_AGENTS=1
      SOLO_AGENTS=$(( NUM_AGENTS - 1 ))
    fi
    if [ "$SOLO_AGENTS" -lt 1 ] && [ "$NUM_AGENTS" -ge 2 ]; then
      SOLO_AGENTS=1
      TEAM_AGENTS=$(( NUM_AGENTS - 1 ))
    fi
    echo "  Split:   ${TEAM_AGENTS} team + ${SOLO_AGENTS} solo"
    echo ""
    ;;
esac

# ─── Launch ────────────────────────────────────────────────────────
PIDS=()
EXIT_CODE=0

if [ "$TEAM_AGENTS" -gt 0 ]; then
  echo "Launching team swarm (${TEAM_AGENTS} agents)..."
  export SWARM_LOG_DIR="${SWARM_LOG_DIR}"
  bash "${SCRIPT_DIR}/swarm-launch.sh" "$TEAM_AGENTS" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT" &
  PIDS+=($!)
fi

if [ "$SOLO_AGENTS" -gt 0 ]; then
  # Offset solo log dir to avoid collision with team logs
  export SWARM_LOG_DIR="${SWARM_LOG_DIR}-solo"
  echo "Launching solo swarm (${SOLO_AGENTS} agents)..."
  bash "${SCRIPT_DIR}/swarm-launch-solo.sh" "$SOLO_AGENTS" "$API_BASE" "$PROXY_HOST" "$PROXY_PORT" &
  PIDS+=($!)
fi

# ─── Wait for all launchers ────────────────────────────────────────
echo ""
echo "Waiting for swarm(s) to complete..."
echo "  PIDs: ${PIDS[*]}"
echo ""

for PID in "${PIDS[@]}"; do
  if ! wait "$PID" 2>/dev/null; then
    EXIT_CODE=1
  fi
done

echo ""
echo "============================================"
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "  Swarm complete (all launchers exited OK)"
else
  echo "  Swarm complete (some launchers had errors)"
fi
echo "============================================"

exit "$EXIT_CODE"
