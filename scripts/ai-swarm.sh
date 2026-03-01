#!/usr/bin/env bash
# ============================================================================
# DomiNode AI Agent Swarm Launcher
#
# Launches a local AI model via SGLang, then runs an AI orchestrator that
# creates autonomous DomiNode agents. Each agent registers its own account,
# manages its wallet, uses the proxy, and posts about its experience.
#
# Requirements:
#   - NVIDIA GPU with sufficient VRAM (e.g., RTX 5090 32GB)
#   - Python 3.10+ with: sglang, crewai, dominusnode (SDK)
#   - Running DomiNode API + proxy gateway
#
# Usage:
#   ./scripts/ai-swarm.sh <num_agents> [team|solo|both]
#
# Examples:
#   ./scripts/ai-swarm.sh 10            # both: 7 team + 3 solo
#   ./scripts/ai-swarm.sh 20 team       # 20 team agents
#   ./scripts/ai-swarm.sh 5 solo        # 5 solo agents
#
# Environment (set in .env.swarm or shell):
#   AI_MODEL              — HuggingFace model ID (default: THUDM/glm-4-9b-chat)
#   AI_MODEL_QUANTIZATION — Quantization method (default: awq)
#   AI_SGLANG_PORT        — SGLang API port (default: 8000)
#   AI_SGLANG_TP          — Tensor parallel degree (default: 1)
#   AI_SGLANG_MEM_FRAC    — GPU memory fraction for SGLang (default: 0.85)
#   AI_SKIP_SERVER        — Set to 1 to skip SGLang launch (use external server)
#   AI_API_BASE           — Override SGLang API URL (default: http://localhost:8000/v1)
#   ADMIN_EMAIL            — Admin email for wallet credit (required)
#   ADMIN_PASSWORD         — Admin password (required)
#   SWARM_AGENT_CREDIT     — Cents per agent wallet (default: 500)
#   SWARM_POST_URLS        — Comma-separated social API endpoints
#   SWARM_POST_TOKENS      — Comma-separated auth tokens
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Load .env.swarm ─────────────────────────────────────────────────
ENV_FILE="${REPO_ROOT}/.env.swarm"
if [ -f "$ENV_FILE" ]; then
  echo "Loading config from ${ENV_FILE}"
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key="$(echo "$key" | xargs)"
    value="$(echo "$value" | xargs)"
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$ENV_FILE"
fi

# ─── Arguments ───────────────────────────────────────────────────────
NUM_AGENTS="${1:?Usage: ai-swarm.sh <num_agents> [team|solo|both]}"
MODE="${2:-both}"

case "$MODE" in
  team|solo|both) ;;
  *) echo "ERROR: Invalid mode '$MODE'. Must be: team, solo, or both"; exit 1 ;;
esac

if ! [[ "$NUM_AGENTS" =~ ^[0-9]+$ ]] || [ "$NUM_AGENTS" -lt 1 ]; then
  echo "ERROR: num_agents must be a positive integer"
  exit 1
fi

# ─── Configuration ───────────────────────────────────────────────────
AI_MODEL="${AI_MODEL:-THUDM/glm-4-9b-chat}"
AI_SGLANG_PORT="${AI_SGLANG_PORT:-8000}"
AI_SGLANG_TP="${AI_SGLANG_TP:-1}"
AI_SGLANG_MEM_FRAC="${AI_SGLANG_MEM_FRAC:-0.85}"
AI_SKIP_SERVER="${AI_SKIP_SERVER:-0}"
AI_API_BASE="${AI_API_BASE:-http://localhost:${AI_SGLANG_PORT}/v1}"
API_BASE="${API_BASE:-http://localhost:3000}"
PROXY_HOST="${PROXY_HOST:-localhost}"
PROXY_PORT="${PROXY_PORT:-8080}"
LOG_DIR="${SWARM_LOG_DIR:-/tmp/dominusnode-ai-swarm}"

: "${ADMIN_EMAIL:?ADMIN_EMAIL required (set in .env.swarm or shell env)}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD required}"

mkdir -p "$LOG_DIR"
trap 'rm -f "${LOG_DIR}/swarm-password.txt" 2>/dev/null' EXIT

echo "============================================"
echo "  DomiNode AI Agent Swarm"
echo "============================================"
echo ""
echo "  Model:       ${AI_MODEL}"
echo "  SGLang port: ${AI_SGLANG_PORT}"
echo "  AI API:      ${AI_API_BASE}"
echo "  Mode:        ${MODE}"
echo "  Agents:      ${NUM_AGENTS}"
echo "  API:         ${API_BASE}"
echo "  Proxy:       ${PROXY_HOST}:${PROXY_PORT}"
echo "  Log dir:     ${LOG_DIR}"
echo ""

# ─── Pre-flight checks ──────────────────────────────────────────────
echo "Pre-flight checks..."

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found"
  exit 1
fi
echo "  Python:  $(python3 --version 2>&1)"

# Check required Python packages
MISSING_PKGS=()
for pkg in crewai dominusnode; do
  if ! python3 -c "import $pkg" 2>/dev/null; then
    MISSING_PKGS+=("$pkg")
  fi
done
if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  echo "ERROR: Missing Python packages: ${MISSING_PKGS[*]}"
  echo "  Install: pip install ${MISSING_PKGS[*]}"
  exit 1
fi
echo "  Packages: crewai, dominusnode OK"

# Check API
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/api/health" 2>/dev/null || echo "000")
if [ "$API_HEALTH" != "200" ]; then
  echo "ERROR: API not reachable at ${API_BASE} (status ${API_HEALTH})"
  exit 1
fi
echo "  API:     OK"

# Check GPU (optional — warn only)
if command -v nvidia-smi &>/dev/null; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
  GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1)
  echo "  GPU:     ${GPU_NAME} (${GPU_VRAM})"
else
  echo "  GPU:     nvidia-smi not found (warning)"
fi

echo ""

# ─── Launch SGLang server (if needed) ────────────────────────────────
SGLANG_PID=""

if [ "$AI_SKIP_SERVER" = "1" ]; then
  echo "Skipping SGLang server launch (AI_SKIP_SERVER=1)"
  echo "Using external AI API at ${AI_API_BASE}"
else
  echo "Launching SGLang server..."
  echo "  Model: ${AI_MODEL}"
  echo "  Port:  ${AI_SGLANG_PORT}"
  echo "  TP:    ${AI_SGLANG_TP}"
  echo "  Mem:   ${AI_SGLANG_MEM_FRAC}"
  echo ""

  python3 -m sglang.launch_server \
    --model-path "$AI_MODEL" \
    --port "$AI_SGLANG_PORT" \
    --tp "$AI_SGLANG_TP" \
    --mem-fraction-static "$AI_SGLANG_MEM_FRAC" \
    --host 127.0.0.1 \
    > "${LOG_DIR}/sglang.log" 2>&1 &
  SGLANG_PID=$!

  echo "  SGLang PID: ${SGLANG_PID}"
  echo "  Waiting for server to be ready..."

  # Wait for SGLang to start (up to 5 minutes for model loading)
  MAX_WAIT=300
  WAITED=0
  while [ "$WAITED" -lt "$MAX_WAIT" ]; do
    if curl -s "${AI_API_BASE}/models" >/dev/null 2>&1; then
      echo "  SGLang server ready! (${WAITED}s)"
      break
    fi
    # Check if process died
    if ! kill -0 "$SGLANG_PID" 2>/dev/null; then
      echo "ERROR: SGLang server died during startup. Check ${LOG_DIR}/sglang.log"
      exit 1
    fi
    sleep 5
    WAITED=$((WAITED + 5))
    echo -ne "\r  Waiting... ${WAITED}/${MAX_WAIT}s"
  done

  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo ""
    echo "ERROR: SGLang server did not start within ${MAX_WAIT}s"
    kill "$SGLANG_PID" 2>/dev/null || true
    exit 1
  fi
  echo ""
fi

# ─── Launch AI orchestrator ──────────────────────────────────────────
echo "Launching AI swarm orchestrator..."
echo ""

export DOMINUSNODE_BASE_URL="$API_BASE"
export DOMINUSNODE_PROXY_HOST="$PROXY_HOST"
export DOMINUSNODE_HTTP_PROXY_PORT="$PROXY_PORT"
export AI_API_BASE
export AI_MODEL

python3 "${SCRIPT_DIR}/ai-swarm-orchestrator.py" \
  --num-agents "$NUM_AGENTS" \
  --mode "$MODE" \
  --api-base "$API_BASE" \
  --proxy-host "$PROXY_HOST" \
  --proxy-port "$PROXY_PORT" \
  --log-dir "$LOG_DIR" \
  2>&1 | tee "${LOG_DIR}/orchestrator.log"

ORCH_EXIT=$?

# ─── Cleanup ─────────────────────────────────────────────────────────
if [ -n "$SGLANG_PID" ]; then
  echo ""
  echo "Stopping SGLang server (PID ${SGLANG_PID})..."
  kill "$SGLANG_PID" 2>/dev/null || true
  wait "$SGLANG_PID" 2>/dev/null || true
  echo "  SGLang server stopped."
fi

echo ""
echo "============================================"
if [ "$ORCH_EXIT" -eq 0 ]; then
  echo "  AI Swarm Complete (success)"
else
  echo "  AI Swarm Complete (exit code: ${ORCH_EXIT})"
fi
echo "  Logs: ${LOG_DIR}/"
echo "============================================"

exit "$ORCH_EXIT"
