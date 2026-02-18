#!/usr/bin/env bash
set -euo pipefail

# Mega stress test: 1,000 users × 500MB each = 500GB total
# Runs 3 scenarios: K (1×500MB), L (5×100MB), M (500×1MB)
#
# Prerequisites:
#   - PostgreSQL running on :5432
#   - Mock target server running
#   - Mock upstream proxy running
#   - Proxy gateway running with relaxed limits
#   - 1,000 test users provisioned
#
# Usage: ./stress-tests/run-mega.sh [k|l|m|all]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="${SCRIPT_DIR}/k6/scenarios"
RESULTS_DIR="${SCRIPT_DIR}/results"
export PATH="/home/circuitbreaker/.local/bin:${PATH}"

# Configuration
PROXY_HOST="${PROXY_HOST:-localhost}"
PROXY_PORT="${PROXY_PORT:-18081}"
TARGET_BASE="${TARGET_BASE:-http://httpbin.org}"
DB_URL="${DATABASE_URL:-postgresql://dominode:dominode_dev@localhost:5432/dominode?sslmode=disable}"

# k6 environment
export HTTP_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export HTTPS_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export K6_NO_USAGE_REPORT=true
export MODE=local
export PROXY_HOST PROXY_PORT TARGET_BASE

mkdir -p "${RESULTS_DIR}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SUMMARY_FILE="${RESULTS_DIR}/stress-mega-${TIMESTAMP}.json"

echo "============================================================"
echo "  DOMINUS NODE MEGA STRESS TEST"
echo "  1,000 Users × 500MB = 500GB Total Bandwidth"
echo "============================================================"
echo "  Proxy:       ${PROXY_HOST}:${PROXY_PORT}"
echo "  Target:      ${TARGET_BASE}"
echo "  HTTP_PROXY:  ${HTTP_PROXY}"
echo "  Results:     ${RESULTS_DIR}"
echo "============================================================"
echo ""

# Relax plan-level rate limits
echo "[*] Relaxing plan session rate limits..."
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: '${DB_URL}' });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 100000');
  await c.end();
  console.log('    Plan limits set to 100000 sessions/min');
})().catch(e => { console.error('    WARN:', e.message); });
" 2>/dev/null || true

# Pre-flight checks
echo "[*] Pre-flight checks..."

if ! test -f "${RESULTS_DIR}/test-users.json"; then
  echo "    FAIL: test-users.json not found. Run provisioning first."
  exit 1
fi

USER_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users.length)")
echo "    Test users: ${USER_COUNT}"

if [ "${USER_COUNT}" -lt 1000 ]; then
  echo "    WARN: Only ${USER_COUNT} users provisioned (need 1000 for full test)"
  echo "    Run: USER_COUNT=1000 DATABASE_URL='${DB_URL}' npx tsx stress-tests/src/setup/provision-users.ts"
fi

PREFLIGHT_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users[0].apiKey)")
if ! curl -s -o /dev/null -w "%{http_code}" "${TARGET_BASE}/payload/tiny" -x "http://test:${PREFLIGHT_KEY}@${PROXY_HOST}:${PROXY_PORT}" | grep -q 200; then
  echo "    FAIL: Cannot reach target through proxy"
  exit 1
fi
echo "    Proxy connectivity: OK"
echo ""

# Scenario selection
WHICH="${1:-all}"

declare -A SCENARIO_MAP
SCENARIO_MAP[k]="scenario-k-single-500mb.js"
SCENARIO_MAP[l]="scenario-l-multi-100mb.js"
SCENARIO_MAP[m]="scenario-m-sustained-1mb.js"

declare -A SCENARIO_DESC
SCENARIO_DESC[k]="K: Single 500MB (1,000 × 1 × 500MB)"
SCENARIO_DESC[l]="L: Multi 100MB  (1,000 × 5 × 100MB)"
SCENARIO_DESC[m]="M: Sustained 1MB (1,000 × 500 × 1MB)"

if [ "${WHICH}" = "all" ]; then
  SCENARIOS=(k l m)
  echo "[*] Running all 3 mega scenarios (~6-7 hours total)"
else
  SCENARIOS=("${WHICH}")
  echo "[*] Running scenario: ${SCENARIO_DESC[${WHICH}]:-${WHICH}}"
fi

TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS_JSON="["

for KEY in "${SCENARIOS[@]}"; do
  SCENARIO_FILE="${SCENARIO_MAP[$KEY]:-}"
  if [ -z "${SCENARIO_FILE}" ]; then
    echo "    SKIP: Unknown scenario '${KEY}'"
    continue
  fi

  SCENARIO_PATH="${K6_DIR}/${SCENARIO_FILE}"
  SCENARIO_NAME="${SCENARIO_FILE%.js}"

  if [ ! -f "${SCENARIO_PATH}" ]; then
    echo "    SKIP: ${SCENARIO_FILE} not found"
    continue
  fi

  echo ""
  echo "============================================================"
  echo "  ${SCENARIO_DESC[$KEY]}"
  echo "  Started: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "============================================================"

  K6_SUMMARY="${RESULTS_DIR}/${SCENARIO_NAME}-${TIMESTAMP}.json"

  set +e
  k6 run \
    --summary-export="${K6_SUMMARY}" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    --env "MODE=${MODE}" \
    --env "PROXY_HOST=${PROXY_HOST}" \
    --env "PROXY_PORT=${PROXY_PORT}" \
    --env "TARGET_BASE=${TARGET_BASE}" \
    "${SCENARIO_PATH}" 2>&1

  K6_EXIT=$?
  set -e

  echo ""
  echo "  Finished: $(date '+%Y-%m-%d %H:%M:%S')"

  if [ -f "${K6_SUMMARY}" ]; then
    REQ_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log(m?.count??m?.values?.count??0)")
    REQ_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log((m?.rate??m?.values?.rate??0).toFixed(1))")
    P95=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(95)']??m?.values?.['p(95)']??0).toFixed(0))")
    P99=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(99)']??m?.values?.['p(99)']??0).toFixed(0))")
    ERR_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_failed;const r=m?.value??0;console.log((r*100).toFixed(2))")
    COMPLETED=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.dominusnode_completed_downloads;console.log(m?.count??m?.values?.count??0)")
    BYTES=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.dominusnode_bytes_transferred;const b=m?.count??m?.values?.count??0;console.log((b/1024/1024/1024).toFixed(2))")

    echo ""
    echo "  Results:"
    echo "    Requests:    ${REQ_COUNT}"
    echo "    Rate:        ${REQ_RATE} req/s"
    echo "    Completed:   ${COMPLETED} downloads"
    echo "    Data:        ${BYTES} GB transferred"
    echo "    Latency:     p95=${P95}ms  p99=${P99}ms"
    echo "    Error rate:  ${ERR_RATE}%"

    if [ "${K6_EXIT}" -eq 0 ]; then
      echo "  Status: PASS"
      TOTAL_PASS=$((TOTAL_PASS + 1))
      STATUS="PASS"
    else
      echo "  Status: FAIL (thresholds exceeded)"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      STATUS="FAIL"
    fi

    [ "${RESULTS_JSON}" != "[" ] && RESULTS_JSON="${RESULTS_JSON},"
    RESULTS_JSON="${RESULTS_JSON}{\"scenario\":\"${SCENARIO_NAME}\",\"status\":\"${STATUS}\",\"requests\":${REQ_COUNT},\"reqPerSec\":${REQ_RATE},\"completedDownloads\":${COMPLETED},\"dataTransferredGB\":${BYTES},\"p95ms\":${P95},\"p99ms\":${P99},\"errorRatePct\":${ERR_RATE}}"
  else
    echo "  Status: ERROR (no summary)"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
done

RESULTS_JSON="${RESULTS_JSON}]"

cat > "${SUMMARY_FILE}" << JSONEOF
{
  "mode": "local-mega",
  "timestamp": "${TIMESTAMP}",
  "proxyHost": "${PROXY_HOST}:${PROXY_PORT}",
  "targetBase": "${TARGET_BASE}",
  "testConfig": "1000 users × 500MB each = 500GB",
  "totalScenarios": $((TOTAL_PASS + TOTAL_FAIL)),
  "passed": ${TOTAL_PASS},
  "failed": ${TOTAL_FAIL},
  "overallStatus": "$([ ${TOTAL_FAIL} -eq 0 ] && echo PASS || echo FAIL)",
  "scenarios": ${RESULTS_JSON}
}
JSONEOF

echo ""
echo "============================================================"
echo "  MEGA TEST SUMMARY"
echo "============================================================"
echo "  Total:   $((TOTAL_PASS + TOTAL_FAIL)) scenarios"
echo "  Passed:  ${TOTAL_PASS}"
echo "  Failed:  ${TOTAL_FAIL}"
echo "  Overall: $([ ${TOTAL_FAIL} -eq 0 ] && echo PASS || echo FAIL)"
echo ""
echo "  Reports:"
echo "    Summary: ${SUMMARY_FILE}"
echo "    Details: ${RESULTS_DIR}/scenario-*-${TIMESTAMP}.json"
echo "============================================================"

# Restore plan rate limits
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: '${DB_URL}' });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 30');
  await c.end();
})().catch(() => {});
" 2>/dev/null || true

exit ${TOTAL_FAIL}
