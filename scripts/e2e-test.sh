#!/usr/bin/env bash
# ─── Dominus Node End-to-End Test Script ────────────────────────────────
# Tests the full AI agent flow: signup → API key → teams → payments → proxy
#
# Prerequisites:
#   1. PostgreSQL running:  docker compose up -d
#   2. Schema applied:      npm run db:migrate
#   3. Backend built:       npm run build
#   4. API server running:  npm run start:api  (in another terminal)
#   5. Proxy running:       npm run start:proxy (in another terminal)
#   6. .env filled with real Stripe test keys + NOWPayments sandbox keys
#
# Usage:
#   bash scripts/e2e-test.sh
#   bash scripts/e2e-test.sh --skip-proxy   # skip proxy test if no relay nodes are connected
#   bash scripts/e2e-test.sh --skip-payments # skip Stripe/crypto (if keys not set)

set -euo pipefail

API="http://localhost:3000"
PROXY="http://localhost:8080"
PASS=0
FAIL=0
SKIP=0
SKIP_PROXY=false
SKIP_PAYMENTS=false

for arg in "$@"; do
  case "$arg" in
    --skip-proxy) SKIP_PROXY=true ;;
    --skip-payments) SKIP_PAYMENTS=true ;;
  esac
done

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}✗${NC} $1: $2"; }
skip() { ((SKIP++)); echo -e "  ${YELLOW}⊘${NC} $1 (skipped)"; }
header() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Generate unique test user
TS=$(date +%s)
TEST_EMAIL="e2e-test-${TS}@dominusnode.test"
TEST_PASS="TestPass123!${TS}"

# ─── Phase 0: Health Check ─────────────────────────────────────────
header "Phase 0: Health Check"

HEALTH=$(curl -sf "${API}/api/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q "ok"; then
  pass "API server is healthy"
else
  echo -e "${RED}ERROR: API server not responding at ${API}/api/health${NC}"
  echo "Start it with: npm run start:api"
  exit 1
fi

# ─── Phase 1: Registration & Auth ──────────────────────────────────
header "Phase 1: Registration & Auth"

# Register
REG_RESP=$(curl -sf -X POST "${API}/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\"}" 2>&1)

if echo "$REG_RESP" | grep -q "token\|id"; then
  pass "Register user: ${TEST_EMAIL}"
else
  fail "Register user" "$REG_RESP"
fi

# Login
LOGIN_RESP=$(curl -sf -X POST "${API}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\"}" 2>&1)

JWT=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
REFRESH=$(echo "$LOGIN_RESP" | grep -o '"refreshToken":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$JWT" ]; then
  pass "Login → got JWT (${#JWT} chars)"
else
  fail "Login" "$LOGIN_RESP"
  echo -e "${RED}Cannot continue without JWT. Exiting.${NC}"
  exit 1
fi

if [ -n "$REFRESH" ]; then
  pass "Login → got refresh token"
else
  fail "Login → refresh token" "missing"
fi

# Get account info
ME_RESP=$(curl -sf "${API}/api/auth/me" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$ME_RESP" | grep -q "${TEST_EMAIL}"; then
  pass "GET /api/auth/me → correct email"
else
  fail "GET /api/auth/me" "$ME_RESP"
fi

# ─── Phase 2: API Key Management ───────────────────────────────────
header "Phase 2: API Key Management"

# Create API key
KEY_RESP=$(curl -sf -X POST "${API}/api/keys" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"label":"e2e-test-key"}' 2>&1)

API_KEY=$(echo "$KEY_RESP" | grep -o '"key":"dn_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$API_KEY" ]; then
  pass "Create API key → ${API_KEY:0:20}..."
else
  fail "Create API key" "$KEY_RESP"
fi

# List keys
KEYS_RESP=$(curl -sf "${API}/api/keys" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$KEYS_RESP" | grep -q "e2e-test-key"; then
  pass "List API keys → found test key"
else
  fail "List API keys" "$KEYS_RESP"
fi

# ─── Phase 3: Wallet ───────────────────────────────────────────────
header "Phase 3: Wallet"

WALLET_RESP=$(curl -sf "${API}/api/wallet" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$WALLET_RESP" | grep -q "balanceCents"; then
  BALANCE=$(echo "$WALLET_RESP" | grep -o '"balanceCents":[0-9]*' | cut -d: -f2)
  pass "GET /api/wallet → balance: ${BALANCE} cents"
else
  fail "GET /api/wallet" "$WALLET_RESP"
fi

# Transaction history
TX_RESP=$(curl -sf "${API}/api/wallet/transactions" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$TX_RESP" | grep -q "transactions"; then
  pass "GET /api/wallet/transactions → OK"
else
  fail "GET /api/wallet/transactions" "$TX_RESP"
fi

# Forecast
FC_RESP=$(curl -sf "${API}/api/wallet/forecast" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$FC_RESP" | grep -q "dailyAvgCents\|trend"; then
  pass "GET /api/wallet/forecast → OK"
else
  fail "GET /api/wallet/forecast" "$FC_RESP"
fi

# ─── Phase 4: Stripe Payment ───────────────────────────────────────
header "Phase 4: Stripe Payment"

if [ "$SKIP_PAYMENTS" = true ]; then
  skip "Stripe checkout (--skip-payments)"
else
  STRIPE_RESP=$(curl -sf -X POST "${API}/api/wallet/topup/stripe" \
    -H "Authorization: Bearer ${JWT}" \
    -H "Content-Type: application/json" \
    -d '{"amountCents":1000}' 2>&1)

  if echo "$STRIPE_RESP" | grep -q "stripe.com\|checkout"; then
    STRIPE_URL=$(echo "$STRIPE_RESP" | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4)
    pass "Stripe checkout → got URL (${#STRIPE_URL} chars)"
    echo -e "    ${YELLOW}→ Open in browser to complete: ${STRIPE_URL:0:80}...${NC}"
  elif echo "$STRIPE_RESP" | grep -q "Invalid API Key\|apiKey"; then
    fail "Stripe checkout" "Invalid Stripe key — update STRIPE_SECRET_KEY in .env"
  else
    fail "Stripe checkout" "$STRIPE_RESP"
  fi
fi

# ─── Phase 5: Crypto Payment ───────────────────────────────────────
header "Phase 5: Crypto Payment"

if [ "$SKIP_PAYMENTS" = true ]; then
  skip "Crypto invoice (--skip-payments)"
else
  CRYPTO_RESP=$(curl -sf -X POST "${API}/api/wallet/topup/crypto" \
    -H "Authorization: Bearer ${JWT}" \
    -H "Content-Type: application/json" \
    -d '{"amountUsd":10,"currency":"btc"}' 2>&1)

  if echo "$CRYPTO_RESP" | grep -q "invoiceUrl\|invoice_url\|nowpayments"; then
    pass "Crypto invoice (BTC, \$10) → got invoice URL"
  elif echo "$CRYPTO_RESP" | grep -q "Unauthorized\|auth"; then
    fail "Crypto invoice" "Invalid NOWPayments key — update NOWPAYMENTS_API_KEY in .env"
  else
    fail "Crypto invoice" "$CRYPTO_RESP"
  fi
fi

# ─── Phase 6: Agentic Wallets ──────────────────────────────────────
header "Phase 6: Agentic Wallets"

AW_RESP=$(curl -sf -X POST "${API}/api/agent-wallet" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"label":"e2e-agent-wallet","spendingLimitCents":5000}' 2>&1)

AW_ID=$(echo "$AW_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$AW_ID" ]; then
  pass "Create agentic wallet → ${AW_ID}"
else
  fail "Create agentic wallet" "$AW_RESP"
fi

# List agentic wallets
AWL_RESP=$(curl -sf "${API}/api/agent-wallet" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$AWL_RESP" | grep -q "e2e-agent-wallet"; then
  pass "List agentic wallets → found test wallet"
else
  fail "List agentic wallets" "$AWL_RESP"
fi

# Get agentic wallet balance
if [ -n "$AW_ID" ]; then
  AWB_RESP=$(curl -sf "${API}/api/agent-wallet/${AW_ID}" -H "Authorization: Bearer ${JWT}" 2>&1)
  if echo "$AWB_RESP" | grep -q "balanceCents"; then
    pass "GET agentic wallet balance → OK"
  else
    fail "GET agentic wallet balance" "$AWB_RESP"
  fi
fi

# ─── Phase 7: Teams ────────────────────────────────────────────────
header "Phase 7: Teams"

TEAM_RESP=$(curl -sf -X POST "${API}/api/teams" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"name":"E2E Test Team","maxMembers":10}' 2>&1)

TEAM_ID=$(echo "$TEAM_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$TEAM_ID" ]; then
  pass "Create team → ${TEAM_ID}"
else
  fail "Create team" "$TEAM_RESP"
fi

# List teams
TEAMS_RESP=$(curl -sf "${API}/api/teams" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$TEAMS_RESP" | grep -q "E2E Test Team"; then
  pass "List teams → found test team"
else
  fail "List teams" "$TEAMS_RESP"
fi

# Team details
if [ -n "$TEAM_ID" ]; then
  TD_RESP=$(curl -sf "${API}/api/teams/${TEAM_ID}" -H "Authorization: Bearer ${JWT}" 2>&1)
  if echo "$TD_RESP" | grep -q "E2E Test Team"; then
    pass "GET team details → OK"
  else
    fail "GET team details" "$TD_RESP"
  fi
fi

# Create team API key
if [ -n "$TEAM_ID" ]; then
  TK_RESP=$(curl -sf -X POST "${API}/api/teams/${TEAM_ID}/keys" \
    -H "Authorization: Bearer ${JWT}" \
    -H "Content-Type: application/json" \
    -d '{"label":"e2e-team-key"}' 2>&1)

  TEAM_KEY=$(echo "$TK_RESP" | grep -o '"key":"dn_[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$TEAM_KEY" ]; then
    pass "Create team API key → ${TEAM_KEY:0:20}..."
  else
    fail "Create team API key" "$TK_RESP"
  fi
fi

# Team members
if [ -n "$TEAM_ID" ]; then
  TM_RESP=$(curl -sf "${API}/api/teams/${TEAM_ID}/members" -H "Authorization: Bearer ${JWT}" 2>&1)
  if echo "$TM_RESP" | grep -q "owner\|members"; then
    pass "List team members → OK"
  else
    fail "List team members" "$TM_RESP"
  fi
fi

# ─── Phase 8: Usage & Plans ────────────────────────────────────────
header "Phase 8: Usage & Plans"

USAGE_RESP=$(curl -sf "${API}/api/usage" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$USAGE_RESP" | grep -q "totalBytes\|records\|usage"; then
  pass "GET /api/usage → OK"
else
  fail "GET /api/usage" "$USAGE_RESP"
fi

PLAN_RESP=$(curl -sf "${API}/api/plans/user/plan" -H "Authorization: Bearer ${JWT}" 2>&1)
if echo "$PLAN_RESP" | grep -q "plan\|name\|pricePerGb"; then
  pass "GET /api/plans/user/plan → OK"
else
  fail "GET /api/plans/user/plan" "$PLAN_RESP"
fi

# ─── Phase 9: Proxy Gateway ────────────────────────────────────────
header "Phase 9: Proxy Gateway"

if [ "$SKIP_PROXY" = true ]; then
  skip "Proxy test (--skip-proxy)"
elif [ -z "$API_KEY" ]; then
  skip "Proxy test (no API key available)"
else
  # Check if proxy is running
  PROXY_CHECK=$(curl -sf --max-time 5 -x "http://user:${API_KEY}@localhost:8080" http://httpbin.org/ip 2>&1 || echo "PROXY_FAIL")

  if echo "$PROXY_CHECK" | grep -q "origin"; then
    PROXY_IP=$(echo "$PROXY_CHECK" | grep -o '"origin": "[^"]*"' | cut -d'"' -f4)
    pass "HTTP proxy → routed through ${PROXY_IP}"
  elif echo "$PROXY_CHECK" | grep -q "PROXY_FAIL\|refused\|timed out"; then
    fail "HTTP proxy" "Proxy gateway not running on :8080 — start with: npm run start:proxy"
  elif echo "$PROXY_CHECK" | grep -q "balance\|insufficient"; then
    fail "HTTP proxy" "Insufficient balance — top up wallet first"
  else
    fail "HTTP proxy" "$PROXY_CHECK"
  fi
fi

# ─── Phase 10: MCP Server Bootstrap ────────────────────────────────
header "Phase 10: MCP Server Readiness"

MCP_BIN="packages/mcp-server/dist/index.js"
if [ -f "$MCP_BIN" ]; then
  pass "MCP server binary exists at ${MCP_BIN}"
else
  fail "MCP server binary" "Not found — run: npm run build"
fi

# Verify the MCP registry manifest exists (server.json, registry schema)
MCP_JSON="packages/mcp-server/server.json"
if [ -f "$MCP_JSON" ]; then
  pass "MCP registry manifest present (${MCP_JSON})"
else
  fail "MCP manifest" "server.json not found"
fi

# ─── Phase 11: SDK Integration Check ───────────────────────────────
header "Phase 11: SDK & Integration Readiness"

for SDK in node python rust go java cpp; do
  if [ -d "sdks/${SDK}" ]; then
    pass "SDK: ${SDK}/ exists"
  else
    fail "SDK: ${SDK}/" "directory missing"
  fi
done

for INT in langchain vercel-ai crewai openai-functions openclaw; do
  if [ -d "integrations/${INT}" ]; then
    pass "Integration: ${INT}/ exists"
  else
    fail "Integration: ${INT}/" "directory missing"
  fi
done

# ─── Cleanup ────────────────────────────────────────────────────────
header "Cleanup"

# Delete API key
if [ -n "$API_KEY" ]; then
  KEY_ID=$(echo "$KEYS_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$KEY_ID" ]; then
    DEL_RESP=$(curl -sf -X DELETE "${API}/api/keys/${KEY_ID}" -H "Authorization: Bearer ${JWT}" 2>&1)
    pass "Deleted test API key"
  fi
fi

# Note: we don't delete the test user (no admin endpoint in this script)
echo -e "  ${YELLOW}Note: Test user ${TEST_EMAIL} left in DB (delete manually or via admin)${NC}"

# ─── Summary ────────────────────────────────────────────────────────
header "Results"
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  ${GREEN}Passed: ${PASS}${NC} / ${RED}Failed: ${FAIL}${NC} / ${YELLOW}Skipped: ${SKIP}${NC} / Total: ${TOTAL}"

if [ "$FAIL" -eq 0 ]; then
  echo -e "\n${GREEN}━━━ ALL TESTS PASSED ━━━${NC}"
  exit 0
else
  echo -e "\n${RED}━━━ ${FAIL} TEST(S) FAILED ━━━${NC}"
  exit 1
fi
