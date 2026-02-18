#!/usr/bin/env bash
set -euo pipefail

# Stress test runner - local mode
# Prerequisites: k6 in PATH, mock servers + proxy running, users provisioned

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="${SCRIPT_DIR}/k6/scenarios"
RESULTS_DIR="${SCRIPT_DIR}/results"
export PATH="/home/circuitbreaker/.local/bin:${PATH}"

# Configuration
PROXY_HOST="${PROXY_HOST:-localhost}"
PROXY_PORT="${PROXY_PORT:-18081}"
SOCKS5_PORT="${SOCKS5_PORT:-11081}"
TARGET_BASE="${TARGET_BASE:-http://httpbin.org}"

# k6 environment
export HTTP_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export HTTPS_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export K6_NO_USAGE_REPORT=true
export MODE=local
export PROXY_HOST PROXY_PORT TARGET_BASE

mkdir -p "${RESULTS_DIR}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SUMMARY_FILE="${RESULTS_DIR}/stress-local-${TIMESTAMP}.json"

echo "============================================================"
echo "  DOMINUS NODE STRESS TEST SUITE"
echo "============================================================"
echo "  Proxy:       ${PROXY_HOST}:${PROXY_PORT}"
echo "  SOCKS5:      ${PROXY_HOST}:${SOCKS5_PORT}"
echo "  Target:      ${TARGET_BASE}"
echo "  HTTP_PROXY:  ${HTTP_PROXY}"
echo "  Results:     ${RESULTS_DIR}"
echo "============================================================"
echo ""

# Relax plan-level rate limits for stress testing
DB_URL="${DATABASE_URL:-postgresql://dominode:dominode_dev@localhost:5432/dominode?sslmode=disable}"
echo "[*] Relaxing plan session rate limits for stress testing..."
node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: '${DB_URL}' });
  await c.connect();
  await c.query('UPDATE plans SET max_sessions_per_minute = 10000');
  await c.end();
  console.log('    Plan limits set to 10000 sessions/min');
})().catch(e => { console.error('    WARN: Could not update plan limits:', e.message); });
" 2>/dev/null || true

# Check connectivity
echo "[*] Pre-flight checks..."
PREFLIGHT_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users[0].apiKey)")
if ! curl -s -o /dev/null -w "%{http_code}" "${TARGET_BASE}/payload/tiny" -x "http://test:${PREFLIGHT_KEY}@${PROXY_HOST}:${PROXY_PORT}" | grep -q 200; then
  echo "    FAIL: Cannot reach target through proxy"
  exit 1
fi
echo "    Proxy connectivity: OK"

if ! test -f "${RESULTS_DIR}/test-users.json"; then
  echo "    FAIL: test-users.json not found. Run provisioning first."
  exit 1
fi
echo "    Test users: OK ($(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users.length)") users)"
echo ""

# Select scenarios
SCENARIOS="${1:-all}"
if [ "${SCENARIOS}" = "all" ]; then
  SCENARIO_FILES=(
    "scenario-a-tiny.js"
    "scenario-b-small.js"
    "scenario-c-medium.js"
    "scenario-f-burst.js"
    "scenario-g-churn.js"
    "scenario-j-errors.js"
  )
  echo "[*] Running 6 core scenarios (skipping D/E/H/I for time)"
elif [ "${SCENARIOS}" = "audit" ]; then
  SCENARIO_FILES=(
    "scenario-n-sessionid-cap.js"
    "scenario-o-redirect-safety.js"
    "scenario-p-response-limits.js"
    "scenario-q-rate-limits.js"
  )
  echo "[*] Running 4 R18 audit validation scenarios"
elif [ "${SCENARIOS}" = "full" ]; then
  SCENARIO_FILES=(
    "scenario-a-tiny.js"
    "scenario-b-small.js"
    "scenario-c-medium.js"
    "scenario-f-burst.js"
    "scenario-g-churn.js"
    "scenario-j-errors.js"
    "scenario-n-sessionid-cap.js"
    "scenario-o-redirect-safety.js"
    "scenario-p-response-limits.js"
    "scenario-q-rate-limits.js"
  )
  echo "[*] Running all 10 scenarios (core + audit)"
else
  SCENARIO_FILES=("scenario-${SCENARIOS}.js")
  echo "[*] Running scenario: ${SCENARIOS}"
fi

TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS_JSON="["

for SCENARIO_FILE in "${SCENARIO_FILES[@]}"; do
  SCENARIO_PATH="${K6_DIR}/${SCENARIO_FILE}"
  SCENARIO_NAME="${SCENARIO_FILE%.js}"

  if [ ! -f "${SCENARIO_PATH}" ]; then
    echo "    SKIP: ${SCENARIO_FILE} not found"
    continue
  fi

  echo ""
  echo "------------------------------------------------------------"
  echo "  Running: ${SCENARIO_NAME}"
  echo "------------------------------------------------------------"

  K6_SUMMARY="${RESULTS_DIR}/${SCENARIO_NAME}-${TIMESTAMP}.json"

  # Run k6 with summary export
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

  if [ -f "${K6_SUMMARY}" ]; then
    # Extract key metrics
    # k6 summary-export format: metrics.http_reqs.count (not .values.count)
    REQ_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log(m?.count??m?.values?.count??0)")
    REQ_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log((m?.rate??m?.values?.rate??0).toFixed(1))")
    P95=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(95)']??m?.values?.['p(95)']??0).toFixed(0))")
    P99=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(99)']??m?.values?.['p(99)']??0).toFixed(0))")
    ERR_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_failed;const r=m?.value??m?.values?.rate??0;console.log((r*100).toFixed(2))")

    echo ""
    echo "  Results: ${REQ_COUNT} reqs | ${REQ_RATE} req/s | p95=${P95}ms | p99=${P99}ms | err=${ERR_RATE}%"

    if [ "${K6_EXIT}" -eq 0 ]; then
      echo "  Status: PASS"
      TOTAL_PASS=$((TOTAL_PASS + 1))
      STATUS="PASS"
    else
      echo "  Status: FAIL (thresholds exceeded)"
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      STATUS="FAIL"
    fi

    # Append to combined results
    [ "${RESULTS_JSON}" != "[" ] && RESULTS_JSON="${RESULTS_JSON},"
    RESULTS_JSON="${RESULTS_JSON}{\"scenario\":\"${SCENARIO_NAME}\",\"status\":\"${STATUS}\",\"requests\":${REQ_COUNT},\"reqPerSec\":${REQ_RATE},\"p95ms\":${P95},\"p99ms\":${P99},\"errorRatePct\":${ERR_RATE}}"
  else
    echo "  Status: ERROR (no summary)"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
done

RESULTS_JSON="${RESULTS_JSON}]"

# Write combined summary
cat > "${SUMMARY_FILE}" << JSONEOF
{
  "mode": "local",
  "timestamp": "${TIMESTAMP}",
  "proxyHost": "${PROXY_HOST}:${PROXY_PORT}",
  "targetBase": "${TARGET_BASE}",
  "totalScenarios": $((TOTAL_PASS + TOTAL_FAIL)),
  "passed": ${TOTAL_PASS},
  "failed": ${TOTAL_FAIL},
  "overallStatus": "$([ ${TOTAL_FAIL} -eq 0 ] && echo PASS || echo FAIL)",
  "scenarios": ${RESULTS_JSON}
}
JSONEOF

echo ""
echo "============================================================"
echo "  SUMMARY"
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

# Restore plan rate limits to production defaults
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
