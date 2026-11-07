#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Dominus Node Production Stress Test Runner
# =============================================================================
# Runs stress tests against a deployed Dominus Node instance.
#
# Two modes:
#   Real upstream (default): Traffic through real Webshare ($1/GB cost).
#     - Double confirmation required
#     - Budget cap enforced
#     - Scenarios K/L/M blocked (500GB each)
#
#   Mock mode (--mock): No cost, higher limits allowed.
#     - User provides --target pointing to a mock server
#     - All scenarios allowed
#
# Usage:
#   # Real upstream (costs money!)
#   ./stress-tests/run-production.sh \
#     --proxy-host proxy.dominusnode.daedalusdevelopmentgroup.com --proxy-port 8080 \
#     --scenario a
#
#   # Mock mode (no cost)
#   ./stress-tests/run-production.sh \
#     --proxy-host localhost --proxy-port 18081 \
#     --target http://mock-target:9090 --mock --scenario a
#
#   # Dry run (prints what would happen)
#   ./stress-tests/run-production.sh \
#     --proxy-host proxy.dominusnode.daedalusdevelopmentgroup.com --proxy-port 8080 \
#     --dry-run --scenario a
#
# Required:
#   --proxy-host HOST     Proxy hostname
#   --proxy-port PORT     Proxy port
#
# Optional:
#   --api-url URL         Dashboard API URL (for REST provisioning)
#   --target URL          Target URL (default: http://httpbin.org)
#   --scenario LETTER     Run single scenario (default: core set a,b,c,f,g,j)
#   --budget DOLLARS      Max spend in USD (default: 5, real mode only)
#   --max-vus N           Max VUs (default: 10 real, 100 mock)
#   --mock                Mock mode — no cost, no confirmation
#   --dry-run             Print plan without executing
#   --skip-cleanup        Don't clean up test data after run
#   --users N             Number of test users to provision (default: 3)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_DIR="${SCRIPT_DIR}/k6/scenarios"
RESULTS_DIR="${SCRIPT_DIR}/results"
export PATH="${HOME}/.local/bin:${PATH}"

# Defaults
PROXY_HOST=""
PROXY_PORT=""
API_URL=""
TARGET_BASE="http://httpbin.org"
SCENARIO=""
BUDGET=5
MAX_VUS=""
MOCK_MODE=false
DRY_RUN=false
SKIP_CLEANUP=false
USER_COUNT=3

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# =============================================================================
# Argument parsing
# =============================================================================
while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy-host)
      PROXY_HOST="$2"
      shift 2
      ;;
    --proxy-port)
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --proxy-port must be a positive integer"
        exit 1
      fi
      PROXY_PORT="$2"
      shift 2
      ;;
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --target)
      TARGET_BASE="$2"
      shift 2
      ;;
    --scenario)
      SCENARIO="$2"
      shift 2
      ;;
    --budget)
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --budget must be a positive integer (USD)"
        exit 1
      fi
      BUDGET="$2"
      shift 2
      ;;
    --max-vus)
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "ERROR: --max-vus must be a positive integer"
        exit 1
      fi
      MAX_VUS="$2"
      shift 2
      ;;
    --mock)
      MOCK_MODE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
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
    -h|--help)
      head -45 "$0" | tail -38
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# =============================================================================
# Dependency checks
# =============================================================================
for cmd in node npx curl bc k6; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: Required command '${cmd}' not found in PATH."
    exit 1
  fi
done

# =============================================================================
# Validation
# =============================================================================
if [ -z "${PROXY_HOST}" ] || [ -z "${PROXY_PORT}" ]; then
  echo "ERROR: --proxy-host and --proxy-port are required."
  echo "Usage: $0 --proxy-host HOST --proxy-port PORT [OPTIONS]"
  exit 1
fi

# Safety cap: prevent accidentally spending hundreds of dollars
MAX_BUDGET_USD=100
if [ "${MOCK_MODE}" = false ] && [ "${BUDGET}" -gt "${MAX_BUDGET_USD}" ]; then
  echo "ERROR: Budget \$${BUDGET} exceeds safety cap (\$${MAX_BUDGET_USD})."
  echo "Edit MAX_BUDGET_USD in the script if you really need more."
  exit 1
fi

# Set VU defaults based on mode
if [ -z "${MAX_VUS}" ]; then
  if [ "${MOCK_MODE}" = true ]; then
    MAX_VUS=100
  else
    MAX_VUS=10
  fi
fi

# =============================================================================
# Scenario definitions and cost estimation
# =============================================================================
# Estimated data per scenario (in MB) at default VU levels
declare -A SCENARIO_DATA_MB
SCENARIO_DATA_MB[a]=1         # 10B payloads, minimal
SCENARIO_DATA_MB[b]=10        # 1KB payloads
SCENARIO_DATA_MB[c]=100       # 10KB payloads
SCENARIO_DATA_MB[d]=2000      # 1MB payloads, 200 VUs
SCENARIO_DATA_MB[e]=500       # 5min sustained
SCENARIO_DATA_MB[f]=200       # Burst
SCENARIO_DATA_MB[g]=100       # Churn
SCENARIO_DATA_MB[h]=50        # Mixed (SOCKS5)
SCENARIO_DATA_MB[i]=1000      # Free tier 1GB exhaustion
SCENARIO_DATA_MB[j]=1         # Error testing
SCENARIO_DATA_MB[k]=512000    # 500GB
SCENARIO_DATA_MB[l]=512000    # 500GB
SCENARIO_DATA_MB[m]=512000    # 500GB

declare -A SCENARIO_FILES
SCENARIO_FILES[a]="scenario-a-tiny.js"
SCENARIO_FILES[b]="scenario-b-small.js"
SCENARIO_FILES[c]="scenario-c-medium.js"
SCENARIO_FILES[d]="scenario-d-large.js"
SCENARIO_FILES[e]="scenario-e-sustained.js"
SCENARIO_FILES[f]="scenario-f-burst.js"
SCENARIO_FILES[g]="scenario-g-churn.js"
SCENARIO_FILES[h]="scenario-h-mixed.js"
SCENARIO_FILES[i]="scenario-i-free-tier.js"
SCENARIO_FILES[j]="scenario-j-errors.js"
SCENARIO_FILES[k]="scenario-k-single-500mb.js"
SCENARIO_FILES[l]="scenario-l-multi-100mb.js"
SCENARIO_FILES[m]="scenario-m-sustained-1mb.js"

declare -A SCENARIO_NAMES
SCENARIO_NAMES[a]="A: Tiny Payloads (10B)"
SCENARIO_NAMES[b]="B: Small Payloads (1KB)"
SCENARIO_NAMES[c]="C: Medium Payloads (10KB)"
SCENARIO_NAMES[d]="D: Large Payloads (1MB)"
SCENARIO_NAMES[e]="E: Sustained Load (5min)"
SCENARIO_NAMES[f]="F: Burst (50-200 VUs)"
SCENARIO_NAMES[g]="G: VU Churn"
SCENARIO_NAMES[h]="H: Mixed Traffic"
SCENARIO_NAMES[i]="I: Free Tier Exhaustion"
SCENARIO_NAMES[j]="J: Error Handling"
SCENARIO_NAMES[k]="K: Single 500MB (500GB total)"
SCENARIO_NAMES[l]="L: Multi 100MB (500GB total)"
SCENARIO_NAMES[m]="M: Sustained 1MB (500GB total)"

# Cost calculation: $1/GB upstream cost
estimate_cost_usd() {
  local data_mb="$1"
  echo "scale=2; ${data_mb} / 1024" | bc
}

# =============================================================================
# Build scenario list
# =============================================================================
if [ -n "${SCENARIO}" ]; then
  SCENARIOS=("${SCENARIO}")
else
  # Default: core scenarios only (not D/E/H/I which are heavier)
  SCENARIOS=(a b c f g j)
fi

# =============================================================================
# Block dangerous scenarios in real mode
# =============================================================================
if [ "${MOCK_MODE}" = false ]; then
  BLOCKED_SCENARIOS=()
  for s in "${SCENARIOS[@]}"; do
    if [[ "$s" =~ ^[klm]$ ]]; then
      echo "WARNING: Scenario ${s^^} blocked in real mode (500GB = ~\$500 upstream cost)"
      BLOCKED_SCENARIOS+=("$s")
    fi
  done

  # Remove blocked scenarios
  FILTERED=()
  for s in "${SCENARIOS[@]}"; do
    blocked=false
    for b in "${BLOCKED_SCENARIOS[@]:-}"; do
      if [ "$s" = "$b" ]; then
        blocked=true
        break
      fi
    done
    if [ "${blocked}" = false ]; then
      FILTERED+=("$s")
    fi
  done
  SCENARIOS=("${FILTERED[@]}")

  if [ ${#SCENARIOS[@]} -eq 0 ]; then
    echo "ERROR: All selected scenarios are blocked in real mode."
    echo "Use --mock to run without cost restrictions."
    exit 1
  fi
fi

# =============================================================================
# Cost estimation
# =============================================================================
TOTAL_ESTIMATED_MB=0
for s in "${SCENARIOS[@]}"; do
  TOTAL_ESTIMATED_MB=$((TOTAL_ESTIMATED_MB + ${SCENARIO_DATA_MB[$s]:-0}))
done
TOTAL_ESTIMATED_COST=$(estimate_cost_usd "${TOTAL_ESTIMATED_MB}")
BUDGET_MB=$(echo "${BUDGET} * 1024" | bc | cut -d. -f1)

# =============================================================================
# Banner
# =============================================================================
echo "============================================================"
echo "  DOMINUS NODE PRODUCTION STRESS TEST"
echo "============================================================"
echo "  Proxy:         ${PROXY_HOST}:${PROXY_PORT}"
echo "  Target:        ${TARGET_BASE}"
echo "  Mode:          $([ "${MOCK_MODE}" = true ] && echo "MOCK (no cost)" || echo "REAL (costs money!)")"
echo "  Max VUs:       ${MAX_VUS}"
echo "  Scenarios:     ${SCENARIOS[*]}"
if [ "${MOCK_MODE}" = false ]; then
  echo "  Est. data:     ${TOTAL_ESTIMATED_MB} MB (~${TOTAL_ESTIMATED_COST} USD upstream)"
  echo "  Budget cap:    \$${BUDGET} USD (${BUDGET_MB} MB)"
fi
echo "  Dry run:       ${DRY_RUN}"
echo "  Users:         ${USER_COUNT}"
echo "============================================================"
echo ""

# =============================================================================
# Budget check (real mode)
# =============================================================================
if [ "${MOCK_MODE}" = false ] && [ "${TOTAL_ESTIMATED_MB}" -gt "${BUDGET_MB}" ]; then
  echo "ERROR: Estimated data (${TOTAL_ESTIMATED_MB} MB) exceeds budget (${BUDGET_MB} MB / \$${BUDGET})."
  echo "Increase --budget or reduce scenarios."
  exit 1
fi

# =============================================================================
# Confirmation (real mode)
# =============================================================================
if [ "${MOCK_MODE}" = false ] && [ "${DRY_RUN}" = false ]; then
  echo "!!! WARNING !!!"
  echo "This will send real traffic through Webshare at \$1/GB upstream cost."
  echo "Estimated cost: ~\$${TOTAL_ESTIMATED_COST} USD"
  echo ""
  read -rp "Type 'yes' to continue: " CONFIRM1
  if [ "${CONFIRM1}" != "yes" ]; then
    echo "Aborted."
    exit 0
  fi
  read -rp "Type 'PRODUCTION' to confirm: " CONFIRM2
  if [ "${CONFIRM2}" != "PRODUCTION" ]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# =============================================================================
# Dry run — print plan and exit
# =============================================================================
if [ "${DRY_RUN}" = true ]; then
  echo "[DRY RUN] Would execute the following:"
  echo ""
  for s in "${SCENARIOS[@]}"; do
    data_mb="${SCENARIO_DATA_MB[$s]:-0}"
    cost=$(estimate_cost_usd "${data_mb}")
    echo "  ${SCENARIO_NAMES[$s]:-Scenario $s}"
    echo "    File:     ${SCENARIO_FILES[$s]:-unknown}"
    echo "    Est data: ${data_mb} MB (~\$${cost})"
    echo "    VUs:      capped at ${MAX_VUS}"
    echo ""
  done
  echo "  Total estimated: ${TOTAL_ESTIMATED_MB} MB (~\$${TOTAL_ESTIMATED_COST})"
  echo ""
  echo "[DRY RUN] No tests executed."
  exit 0
fi

# =============================================================================
# User provisioning
# =============================================================================
echo "[*] Provisioning test users..."
mkdir -p "${RESULTS_DIR}"

if [ -n "${DATABASE_URL:-}" ]; then
  # Direct DB access — fastest, bypasses rate limits
  echo "    Using direct database provisioning (DATABASE_URL set)"
  DATABASE_URL="${DATABASE_URL}" \
    USER_COUNT="${USER_COUNT}" \
    BALANCE_CENTS=1000000 \
    npx tsx "${SCRIPT_DIR}/src/setup/provision-users.ts"

elif [ -n "${API_URL}" ]; then
  # REST API provisioning — limited by rate limits
  echo "    Using REST API provisioning (${API_URL})"
  if [ "${USER_COUNT}" -gt 3 ] && [ "${MOCK_MODE}" = false ]; then
    echo "    WARNING: Per-IP registration rate limit is 3 accounts/hour."
    echo "    Only ${USER_COUNT} users requested but may be limited."
    echo "    For more users, set DATABASE_URL for direct provisioning."
  fi
  API_BASE_URL="${API_URL}" \
    USER_COUNT="${USER_COUNT}" \
    npx tsx "${SCRIPT_DIR}/src/setup/provision-via-api.ts"

elif [ -f "${RESULTS_DIR}/test-users.json" ]; then
  # Use pre-provisioned users
  EXISTING_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users.length)")
  echo "    Using pre-provisioned users: ${EXISTING_COUNT} found"
  if [ "${EXISTING_COUNT}" -eq 0 ]; then
    echo "    ERROR: test-users.json has no users."
    exit 1
  fi

else
  echo "    ERROR: No way to provision users."
  echo "    Set DATABASE_URL for direct DB access,"
  echo "    or --api-url for REST API provisioning,"
  echo "    or place test-users.json in ${RESULTS_DIR}/"
  exit 1
fi

# Verify users file exists
if [ ! -f "${RESULTS_DIR}/test-users.json" ]; then
  echo "    ERROR: test-users.json not found after provisioning."
  exit 1
fi

USER_ACTUAL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users.length)")
echo "    Test users ready: ${USER_ACTUAL}"

# =============================================================================
# Pre-flight connectivity check
# =============================================================================
echo "[*] Pre-flight checks..."
PREFLIGHT_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${RESULTS_DIR}/test-users.json','utf-8')).users[0].apiKey)")
PREFLIGHT_URL="${TARGET_BASE}/ip"

if [ "${MOCK_MODE}" = true ]; then
  PREFLIGHT_URL="${TARGET_BASE}/health"
fi

PREFLIGHT_STATUS=$(curl -sf --max-time 15 -o /dev/null -w "%{http_code}" \
  "${PREFLIGHT_URL}" \
  -x "http://test:${PREFLIGHT_KEY}@${PROXY_HOST}:${PROXY_PORT}" 2>/dev/null || echo "000")

if [ "${PREFLIGHT_STATUS}" -ne 200 ]; then
  echo "    FAIL: Proxy connectivity check returned HTTP ${PREFLIGHT_STATUS}"
  echo "    URL: ${PREFLIGHT_URL}"
  echo "    Proxy: ${PROXY_HOST}:${PROXY_PORT}"
  exit 1
fi
echo "    Proxy connectivity: OK"
echo ""

# =============================================================================
# k6 environment
# =============================================================================
export HTTP_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export HTTPS_PROXY="http://${PROXY_HOST}:${PROXY_PORT}"
export K6_NO_USAGE_REPORT=true
export MODE=production
export PROXY_HOST PROXY_PORT TARGET_BASE

SUMMARY_FILE="${RESULTS_DIR}/production-${TIMESTAMP}.json"
TOTAL_PASS=0
TOTAL_FAIL=0
CUMULATIVE_MB=0
RESULTS_JSON="["

# =============================================================================
# Run scenarios
# =============================================================================
for s in "${SCENARIOS[@]}"; do
  SCENARIO_FILE="${SCENARIO_FILES[$s]:-}"
  SCENARIO_NAME="${SCENARIO_NAMES[$s]:-Scenario $s}"

  if [ -z "${SCENARIO_FILE}" ]; then
    echo "    SKIP: Unknown scenario '${s}'"
    continue
  fi

  SCENARIO_PATH="${K6_DIR}/${SCENARIO_FILE}"
  if [ ! -f "${SCENARIO_PATH}" ]; then
    echo "    SKIP: ${SCENARIO_FILE} not found"
    continue
  fi

  # Pre-scenario budget check (real mode)
  SCENARIO_MB="${SCENARIO_DATA_MB[$s]:-0}"
  if [ "${MOCK_MODE}" = false ]; then
    PROJECTED=$((CUMULATIVE_MB + SCENARIO_MB))
    if [ "${PROJECTED}" -gt "${BUDGET_MB}" ]; then
      echo "    SKIP: ${SCENARIO_NAME} — would exceed budget"
      echo "           (cumulative ${CUMULATIVE_MB}MB + ${SCENARIO_MB}MB > ${BUDGET_MB}MB cap)"
      continue
    fi
    SCENARIO_COST=$(estimate_cost_usd "${SCENARIO_MB}")
    echo "    Cost estimate: ~${SCENARIO_MB} MB (~\$${SCENARIO_COST})"
  fi

  echo ""
  echo "------------------------------------------------------------"
  echo "  Running: ${SCENARIO_NAME}"
  echo "  Started: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "------------------------------------------------------------"

  K6_SUMMARY="${RESULTS_DIR}/production-${s}-${TIMESTAMP}.json"

  set +e
  k6 run \
    --summary-export="${K6_SUMMARY}" \
    --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99)" \
    --env "MODE=production" \
    --env "PROXY_HOST=${PROXY_HOST}" \
    --env "PROXY_PORT=${PROXY_PORT}" \
    --env "TARGET_BASE=${TARGET_BASE}" \
    "${SCENARIO_PATH}" 2>&1

  K6_EXIT=$?
  set -e

  echo "  Finished: $(date '+%Y-%m-%d %H:%M:%S')"

  if [ -f "${K6_SUMMARY}" ]; then
    REQ_COUNT=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log(m?.count??m?.values?.count??0)")
    REQ_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_reqs;console.log((m?.rate??m?.values?.rate??0).toFixed(1))")
    P95=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(95)']??m?.values?.['p(95)']??0).toFixed(0))")
    P99=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_duration;console.log((m?.['p(99)']??m?.values?.['p(99)']??0).toFixed(0))")
    ERR_RATE=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.http_req_failed;const r=m?.value??m?.values?.rate??0;console.log((r*100).toFixed(2))")
    BYTES=$(node -e "const d=JSON.parse(require('fs').readFileSync('${K6_SUMMARY}','utf-8'));const m=d.metrics?.dominusnode_bytes_transferred;const b=m?.count??m?.values?.count??0;console.log(Math.ceil(b/1024/1024))")

    CUMULATIVE_MB=$((CUMULATIVE_MB + BYTES))

    echo ""
    echo "  Results: ${REQ_COUNT} reqs | ${REQ_RATE} req/s | p95=${P95}ms | p99=${P99}ms | err=${ERR_RATE}%"
    echo "  Data:    ${BYTES} MB (cumulative: ${CUMULATIVE_MB} MB)"

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
    RESULTS_JSON="${RESULTS_JSON}{\"scenario\":\"${s}\",\"name\":\"${SCENARIO_NAME}\",\"status\":\"${STATUS}\",\"requests\":${REQ_COUNT},\"reqPerSec\":${REQ_RATE},\"dataMB\":${BYTES},\"p95ms\":${P95},\"p99ms\":${P99},\"errorRatePct\":${ERR_RATE}}"
  else
    echo "  Status: ERROR (no summary file)"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi

  # Post-scenario budget check (real mode)
  if [ "${MOCK_MODE}" = false ] && [ "${CUMULATIVE_MB}" -gt "${BUDGET_MB}" ]; then
    echo ""
    echo "  BUDGET EXCEEDED: ${CUMULATIVE_MB} MB > ${BUDGET_MB} MB cap"
    echo "  Stopping remaining scenarios."
    break
  fi
done

RESULTS_JSON="${RESULTS_JSON}]"

# =============================================================================
# Write summary
# =============================================================================
cat > "${SUMMARY_FILE}" << JSONEOF
{
  "mode": "production",
  "mockMode": ${MOCK_MODE},
  "timestamp": "${TIMESTAMP}",
  "proxyHost": "${PROXY_HOST}:${PROXY_PORT}",
  "targetBase": "${TARGET_BASE}",
  "budgetUsd": ${BUDGET},
  "totalDataMB": ${CUMULATIVE_MB},
  "estimatedCostUsd": $(estimate_cost_usd "${CUMULATIVE_MB}"),
  "totalScenarios": $((TOTAL_PASS + TOTAL_FAIL)),
  "passed": ${TOTAL_PASS},
  "failed": ${TOTAL_FAIL},
  "overallStatus": "$([ ${TOTAL_FAIL} -eq 0 ] && echo PASS || echo FAIL)",
  "scenarios": ${RESULTS_JSON}
}
JSONEOF

# =============================================================================
# Cleanup
# =============================================================================
if [ "${SKIP_CLEANUP}" = false ] && [ -n "${DATABASE_URL:-}" ]; then
  echo ""
  echo "[*] Cleaning up test data..."
  DATABASE_URL="${DATABASE_URL}" npx tsx "${SCRIPT_DIR}/src/setup/cleanup.ts" 2>/dev/null || true
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "============================================================"
echo "  PRODUCTION STRESS TEST SUMMARY"
echo "============================================================"
echo "  Proxy:     ${PROXY_HOST}:${PROXY_PORT}"
echo "  Mode:      $([ "${MOCK_MODE}" = true ] && echo "MOCK" || echo "REAL")"
echo "  Total:     $((TOTAL_PASS + TOTAL_FAIL)) scenarios"
echo "  Passed:    ${TOTAL_PASS}"
echo "  Failed:    ${TOTAL_FAIL}"
echo "  Overall:   $([ ${TOTAL_FAIL} -eq 0 ] && echo PASS || echo FAIL)"
echo "  Data:      ${CUMULATIVE_MB} MB transferred"
if [ "${MOCK_MODE}" = false ]; then
  echo "  Est. cost: ~\$$(estimate_cost_usd "${CUMULATIVE_MB}") USD"
fi
echo ""
echo "  Report:    ${SUMMARY_FILE}"
echo "============================================================"

exit ${TOTAL_FAIL}
