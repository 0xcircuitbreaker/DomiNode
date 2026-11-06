#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Dominus Node Stress Test Bootstrap
# =============================================================================
# Stands up the full local environment for stress testing:
#   - PostgreSQL (via docker-compose)
#   - Mock target server (port 9090)
#   - Mock upstream proxy (port 31112)
#   - Proxy gateway (HTTP :18081, SOCKS5 :11081)
#   - Dashboard API (:13000)
#   - Provisions test users
#
# Usage:
#   ./stress-tests/bootstrap.sh [OPTIONS]
#
# Options:
#   --docker        Use docker-compose for everything (not just PG)
#   --users N       Number of test users to provision (default: 100)
#   --balance N     Balance in cents per user (default: 10000 = $100)
#   --skip-build    Skip npm build step
#   --teardown      Only tear down existing environment, then exit
#
# Ctrl+C to tear down cleanly.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/results"

# Defaults
MODE="native"
USER_COUNT=100
BALANCE_CENTS=10000
SKIP_BUILD=false
TEARDOWN_ONLY=false

# Stress-specific ports (avoid conflict with dev)
PROXY_HTTP_PORT=18081
PROXY_SOCKS5_PORT=11081
API_PORT=13000
MOCK_TARGET_PORT=9090
MOCK_UPSTREAM_PORT=31112

# Database
DB_USER="dominusnode"
DB_PASS="dominusnode_dev"
DB_NAME="dominusnode"
DB_PORT=5432
DB_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}?sslmode=disable"

# Track background PIDs for cleanup
PIDS=()

# =============================================================================
# Argument parsing
# =============================================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      MODE="docker"
      shift
      ;;
    --users)
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --users must be a positive integer"
        exit 1
      fi
      USER_COUNT="$2"
      shift 2
      ;;
    --balance)
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --balance must be a positive integer (cents)"
        exit 1
      fi
      BALANCE_CENTS="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --teardown)
      TEARDOWN_ONLY=true
      shift
      ;;
    -h|--help)
      head -30 "$0" | tail -20
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# =============================================================================
# Cleanup handler
# =============================================================================
cleanup() {
  echo ""
  echo "[*] Shutting down stress test environment..."

  # Kill background processes
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "    Stopping PID ${pid}..."
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  # Restore plan rate limits
  echo "    Restoring plan rate limits..."
  DATABASE_URL="${DB_URL}" node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 30');
  await c.end();
})().catch(() => {});
" 2>/dev/null || true

  if [ "${MODE}" = "docker" ]; then
    echo "    Stopping docker-compose services..."
    docker compose -f "${SCRIPT_DIR}/docker-compose.stress.yml" down 2>/dev/null || true
  fi

  echo "[*] Shutdown complete."
}

trap cleanup EXIT INT TERM

# =============================================================================
# Teardown-only mode
# =============================================================================
if [ "${TEARDOWN_ONLY}" = true ]; then
  echo "[*] Teardown-only mode"

  # Kill any lingering stress-test processes
  pkill -f "mock/target-server" 2>/dev/null || true
  pkill -f "mock/upstream-proxy" 2>/dev/null || true
  pkill -f "PROXY_LISTEN_PORT=${PROXY_HTTP_PORT}" 2>/dev/null || true
  pkill -f "DASHBOARD_PORT=${API_PORT}" 2>/dev/null || true

  # Run cleanup if DB is available
  if pg_isready -h localhost -p "${DB_PORT}" -U "${DB_USER}" -q 2>/dev/null; then
    echo "    Running test data cleanup..."
    DATABASE_URL="${DB_URL}" npx tsx "${SCRIPT_DIR}/src/setup/cleanup.ts" 2>/dev/null || true
  fi

  docker compose -f "${SCRIPT_DIR}/docker-compose.stress.yml" down 2>/dev/null || true
  echo "[*] Teardown complete."
  exit 0
fi

# =============================================================================
# Pre-flight dependency checks
# =============================================================================
for cmd in docker node npx nc curl bc; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: Required command '${cmd}' not found in PATH."
    exit 1
  fi
done

# =============================================================================
# Banner
# =============================================================================
echo "============================================================"
echo "  DOMINUS NODE STRESS TEST BOOTSTRAP"
echo "============================================================"
echo "  Mode:        ${MODE}"
echo "  Users:       ${USER_COUNT}"
echo "  Balance:     \$$(echo "scale=2; ${BALANCE_CENTS} / 100" | bc) per user"
echo "  Skip build:  ${SKIP_BUILD}"
echo "============================================================"
echo ""

# =============================================================================
# Helper: wait for a TCP port to become available
# =============================================================================
wait_for_port() {
  local host="$1" port="$2" label="$3" timeout="${4:-60}"
  local elapsed=0
  echo -n "    Waiting for ${label} on :${port}..."
  while ! nc -z "${host}" "${port}" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo " TIMEOUT (${timeout}s)"
      echo "    FATAL: ${label} did not start on :${port}"
      exit 1
    fi
  done
  echo " OK (${elapsed}s)"
}

# =============================================================================
# Helper: wait for HTTP health endpoint
# =============================================================================
wait_for_health() {
  local url="$1" label="$2" timeout="${3:-60}"
  local elapsed=0
  echo -n "    Waiting for ${label} health..."
  while ! curl -sf --max-time 5 "${url}" >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo " TIMEOUT (${timeout}s)"
      echo "    FATAL: ${label} health check failed at ${url}"
      exit 1
    fi
  done
  echo " OK (${elapsed}s)"
}

# =============================================================================
# Docker mode
# =============================================================================
if [ "${MODE}" = "docker" ]; then
  echo "[1/4] Starting docker-compose services..."
  docker compose -f "${SCRIPT_DIR}/docker-compose.stress.yml" up -d --build

  echo "[2/4] Waiting for services to be healthy..."
  wait_for_port localhost "${DB_PORT}" "PostgreSQL" 30
  wait_for_health "http://localhost:${MOCK_TARGET_PORT}/health" "Mock Target" 30
  wait_for_health "http://localhost:${MOCK_UPSTREAM_PORT}/health" "Mock Upstream" 30
  wait_for_port localhost 8080 "Proxy Gateway" 60
  wait_for_port localhost 3000 "Dashboard API" 60

  echo "[3/4] Provisioning ${USER_COUNT} test users..."
  mkdir -p "${RESULTS_DIR}"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}" \
    USER_COUNT="${USER_COUNT}" \
    BALANCE_CENTS="${BALANCE_CENTS}" \
    npx tsx "${SCRIPT_DIR}/src/setup/provision-users.ts"

  echo "[4/4] Relaxing plan rate limits..."
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}" \
  node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 10000');
  await c.end();
  console.log('    Plan limits set to 10000 sessions/min');
})().catch(e => { console.error('    WARN:', e.message); });
" 2>/dev/null || true

  echo ""
  echo "============================================================"
  echo "  STRESS TEST ENVIRONMENT READY (Docker)"
  echo "============================================================"
  echo "  Proxy HTTP:    localhost:8080"
  echo "  Proxy SOCKS5:  localhost:1080"
  echo "  Dashboard API: localhost:3000"
  echo "  Mock Target:   localhost:${MOCK_TARGET_PORT}"
  echo "  Mock Upstream: localhost:${MOCK_UPSTREAM_PORT}"
  echo "  PostgreSQL:    localhost:${DB_PORT}"
  echo ""
  echo "  Test users:    ${RESULTS_DIR}/test-users.json"
  echo ""
  echo "  Run tests (adjust ports for docker):"
  echo "    PROXY_PORT=8080 ./stress-tests/run-local.sh all"
  echo ""
  echo "  Press Ctrl+C to tear down."
  echo "============================================================"

  # Wait forever until interrupted
  while true; do sleep 3600; done
fi

# =============================================================================
# Native mode
# =============================================================================

# Step 1: Start PostgreSQL
echo "[1/8] Starting PostgreSQL via docker-compose..."
docker compose -f "${PROJECT_DIR}/docker-compose.yml" up -d 2>/dev/null || \
  docker compose -f "${SCRIPT_DIR}/docker-compose.stress.yml" up -d postgres
wait_for_port localhost "${DB_PORT}" "PostgreSQL" 30

# Step 2: Build project
if [ "${SKIP_BUILD}" = true ]; then
  echo "[2/8] Skipping build (--skip-build)"
else
  echo "[2/8] Building project..."
  (cd "${PROJECT_DIR}" && npm run build)
  # Copy schema.sql to dist/ for migrate script
  cp "${PROJECT_DIR}/packages/shared/src/schema.sql" "${PROJECT_DIR}/packages/shared/dist/src/" 2>/dev/null || true
fi

# Step 3: Run migration
echo "[3/8] Running database migration..."
DATABASE_URL="${DB_URL}" node "${PROJECT_DIR}/packages/shared/dist/src/migrate.js" 2>/dev/null || {
  echo "    Migration script not found or failed, trying npx..."
  (cd "${PROJECT_DIR}" && DATABASE_URL="${DB_URL}" npm run db:migrate) || true
}

# Step 4: Start mock target server
echo "[4/8] Starting mock target server on :${MOCK_TARGET_PORT}..."
PORT="${MOCK_TARGET_PORT}" \
  npx tsx "${SCRIPT_DIR}/src/mock/target-server.ts" &
PIDS+=($!)
wait_for_health "http://localhost:${MOCK_TARGET_PORT}/health" "Mock Target" 15

# Step 5: Start mock upstream proxy
echo "[5/8] Starting mock upstream proxy on :${MOCK_UPSTREAM_PORT}..."
PORT="${MOCK_UPSTREAM_PORT}" \
  TARGET_HOST="localhost" \
  TARGET_PORT="${MOCK_TARGET_PORT}" \
  FORCE_TARGET=1 \
  npx tsx "${SCRIPT_DIR}/src/mock/upstream-proxy.ts" &
PIDS+=($!)
wait_for_health "http://localhost:${MOCK_UPSTREAM_PORT}/health" "Mock Upstream" 15

# Step 6: Start proxy gateway (stress-specific ports)
echo "[6/8] Starting proxy gateway on HTTP :${PROXY_HTTP_PORT}, SOCKS5 :${PROXY_SOCKS5_PORT}..."
DATABASE_URL="${DB_URL}" \
  PROXY_LISTEN_PORT="${PROXY_HTTP_PORT}" \
  SOCKS5_LISTEN_PORT="${PROXY_SOCKS5_PORT}" \
  JWT_SECRET="stress-test-jwt-secret-do-not-use-in-production" \
  SKIP_GEOIP=1 \
  MAX_SESSIONS_PER_MINUTE=1000 \
  MAX_BANDWIDTH_PER_HOUR_BYTES=107374182400 \
  LOG_LEVEL=warn \
  BALANCE_CACHE_TTL_MS=1000 \
  PROXY_MAX_CONNECTIONS=5000 \
  PROXY_CONNECT_TIMEOUT_MS=30000 \
  node "${PROJECT_DIR}/packages/proxy-gateway/dist/src/main.js" &
PIDS+=($!)
wait_for_port localhost "${PROXY_HTTP_PORT}" "Proxy Gateway" 30

# Step 7: Start dashboard API (stress-specific port)
echo "[7/8] Starting dashboard API on :${API_PORT}..."
DATABASE_URL="${DB_URL}" \
  DASHBOARD_PORT="${API_PORT}" \
  JWT_SECRET="stress-test-jwt-secret-do-not-use-in-production" \
  SKIP_GEOIP=1 \
  LOG_LEVEL=warn \
  CORS_ORIGINS="*" \
  STRIPE_SECRET_KEY="sk_test_fake" \
  STRIPE_WEBHOOK_SECRET="whsec_fake" \
  NOWPAYMENTS_API_KEY="fake_key" \
  NOWPAYMENTS_IPN_SECRET="fake_ipn_secret" \
  node "${PROJECT_DIR}/packages/dashboard/dist/src/main.js" &
PIDS+=($!)
wait_for_port localhost "${API_PORT}" "Dashboard API" 30

# Step 8: Provision users and relax rate limits
echo "[8/8] Provisioning ${USER_COUNT} test users..."
mkdir -p "${RESULTS_DIR}"
DATABASE_URL="${DB_URL}" \
  USER_COUNT="${USER_COUNT}" \
  BALANCE_CENTS="${BALANCE_CENTS}" \
  npx tsx "${SCRIPT_DIR}/src/setup/provision-users.ts"

# Relax plan rate limits for stress testing
echo "    Relaxing plan session rate limits..."
DATABASE_URL="${DB_URL}" node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 10000');
  await c.end();
  console.log('    Plan limits set to 10000 sessions/min');
})().catch(e => { console.error('    WARN:', e.message); });
" 2>/dev/null || true

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "============================================================"
echo "  STRESS TEST ENVIRONMENT READY (Native)"
echo "============================================================"
echo "  Proxy HTTP:    localhost:${PROXY_HTTP_PORT}"
echo "  Proxy SOCKS5:  localhost:${PROXY_SOCKS5_PORT}"
echo "  Dashboard API: localhost:${API_PORT}"
echo "  Mock Target:   localhost:${MOCK_TARGET_PORT}"
echo "  Mock Upstream: localhost:${MOCK_UPSTREAM_PORT}"
echo "  PostgreSQL:    localhost:${DB_PORT}"
echo ""
echo "  Test users:    ${RESULTS_DIR}/test-users.json"
echo "  PIDs:          ${PIDS[*]}"
echo ""
echo "  Run tests:"
echo "    ./stress-tests/run-local.sh all"
echo "    ./stress-tests/run-local.sh a"
echo "    ./stress-tests/run-mega.sh k"
echo ""
echo "  Press Ctrl+C to tear down."
echo "============================================================"

# Wait forever until interrupted
while true; do sleep 3600; done
