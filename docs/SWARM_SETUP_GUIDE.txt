================================================================================
  DomiNode Agent Swarm — Complete Setup & Usage Guide
  Last updated: 2026-02-27
================================================================================

TABLE OF CONTENTS
  1. Overview — What the swarm does
  2. Prerequisites
  3. Environment Variables (complete reference)
  4. Mode A: Team-Based Swarm (recommended for large swarms)
  5. Mode B: Solo Agent Swarm (individual agents, no teams)
  6. How Admin Credits Work (security model)
  7. Posting Setup (social platforms)
  8. Running the Swarm
  9. Monitoring & Troubleshooting
  10. Bandwidth Budget Reference

================================================================================
1. OVERVIEW
================================================================================

The DomiNode agent swarm launches AI agents that use the DomiNode proxy
service. Each agent scrapes real targets via residential proxy and posts
about its experience via DC proxy — demonstrating the product to attract
other AI agent swarm operators.

Two modes are available:

  MODE A: Team-Based Swarm (recommended)
    - 1 main agent creates a team with a shared wallet
    - N sub-agents use team API keys (no per-agent registration)
    - Team plan (payg) = unrestricted pool access
    - Single wallet funds the entire swarm

  MODE B: Solo Agent Swarm
    - Each agent registers its own account
    - Each gets a personal API key + personal wallet
    - Admin bulk-credits each agent's wallet
    - Uses swarm-mixed or swarm-dc plan

================================================================================
2. PREREQUISITES
================================================================================

  a) Services running:
     docker compose up -d          # PostgreSQL
     npm run db:migrate             # Apply schema (creates plans, tables)
     npm run build                  # Compile TypeScript
     npm run start:api &            # REST API on :3000
     npm run start:proxy &          # Proxy gateway on :8080

  b) Admin account exists:
     Your admin email must be in ADMIN_CREDIT_EMAILS env var (or match
     the default: sarris88p@gmail.com). This admin is the only one who
     can credit wallets.

  c) Plans exist in DB (auto-created by schema.sql):
     - payg:        PAYG, $5/GB residential, $3/GB DC, no bandwidth cap
     - swarm-dc:    200MB/month, DC only, 2 connections
     - swarm-mixed: 200MB/month, all pools, 2 connections

  d) Webshare credentials configured in .env:
     WEBSHARE_API_KEY, WEBSHARE_DC_USERNAME, WEBSHARE_DC_PASSWORD,
     WEBSHARE_RES_USERNAME, WEBSHARE_RES_PASSWORD

================================================================================
3. ENVIRONMENT VARIABLES (complete reference)
================================================================================

─── Required for ALL modes ─────────────────────────────────────────────

  ADMIN_PASSWORD          Admin account password (for admin login)
                          No default — MUST be set.

─── Required for Mode A (Team Swarm) ───────────────────────────────────

  (ADMIN_JWT is obtained automatically by swarm-launch.sh)

─── Required for Mode B (Solo Swarm) ──────────────────────────────────

  ADMIN_JWT               JWT token from admin login
                          (must be obtained manually or via script)

─── Optional (both modes) ──────────────────────────────────────────────

  ADMIN_EMAIL             Admin email for login
                          Default: sarris88p@gmail.com

  SWARM_PASSWORD          Shared password for agent accounts
                          Default: random 32-char hex (auto-generated)

  SWARM_TEAM_CREDIT       Cents to credit team wallet (Mode A only)
                          Default: 10000 (= $100.00)

  SWARM_BATCH_SIZE        Agents launched per batch
                          Default: 25

  SWARM_BATCH_DELAY       Seconds between batches
                          Default: 10

  SWARM_CYCLES            Scrape-post cycles per agent
                          Default: 5

  SWARM_DELAY_SEC         Seconds between requests
                          Default: 5

  SWARM_RES_SCRAPES       Residential scrapes per cycle (Mode A)
                          Default: 1 (conservation mode)

  SWARM_DC_REQUESTS       DC requests per cycle (Mode A)
                          Default: 4

  SWARM_SCRAPES_PER_CYCLE Residential scrapes per cycle (Mode B)
                          Default: 5

  SWARM_POSTS_PER_CYCLE   Posts per cycle (Mode B)
                          Default: 3

  SWARM_LOG_DIR           Where to write agent logs
                          Default: /tmp/dominusnode-swarm

─── Posting (both modes) ───────────────────────────────────────────────

  SWARM_POST_URLS         Comma-separated social API POST endpoints
                          Example: https://moltbook.app/api/v1/statuses

  SWARM_POST_TOKENS       Comma-separated Bearer tokens (1:1 with URLs)
                          Example: tok_abc123,tok_def456

  SWARM_SCRAPE_TARGETS    Comma-separated URLs for residential scraping
                          Default: https://www.google.com/search?q=dominusnode

─── Server-side (.env file) ────────────────────────────────────────────

  These go in your project .env file (not exported to shell):

  DATABASE_URL            PostgreSQL connection string
  JWT_SECRET              Secret for signing JWTs (min 32 chars)
  WEBSHARE_API_KEY        Webshare API key
  WEBSHARE_DC_USERNAME    Webshare DC proxy username
  WEBSHARE_DC_PASSWORD    Webshare DC proxy password
  WEBSHARE_RES_USERNAME   Webshare residential proxy username
  WEBSHARE_RES_PASSWORD   Webshare residential proxy password
  STRIPE_SECRET_KEY       Stripe API key (for fiat payments)
  NOWPAYMENTS_API_KEY     NOWPayments key (for crypto)
  ADMIN_CREDIT_EMAILS     Comma-separated admin emails for wallet credits
                          Default: sarris88p@gmail.com
  MAX_REGISTERED_USERS    Cap on total user accounts
                          Default: 5000
  TRUST_PROXY             Express trust proxy setting
                          Default: 1 (in production)

================================================================================
4. MODE A: TEAM-BASED SWARM (recommended)
================================================================================

How it works:
  1. swarm-launch.sh authenticates as admin
  2. Launches swarm-main-agent.sh
  3. Main agent registers 1 account, creates a team
  4. Admin JWT credits the team wallet ($100 default)
  5. Main agent creates N team API keys
  6. Launches N copies of swarm-agent.sh, each with a team key
  7. Each sub-agent runs cycles: residential scrape + DC API calls + post

Commands:

  # Minimal (10 agents, defaults):
  ADMIN_PASSWORD=yourpass ./scripts/swarm-launch.sh 10

  # Full production (200 agents, with posting):
  ADMIN_PASSWORD=yourpass \
  SWARM_TEAM_CREDIT=50000 \
  SWARM_POST_URLS="https://moltbook.app/api/v1/statuses,https://mastodon.social/api/v1/statuses" \
  SWARM_POST_TOKENS="tok_moltbook_abc,tok_mastodon_def" \
  SWARM_CYCLES=10 \
  SWARM_RES_SCRAPES=1 \
  SWARM_DC_REQUESTS=4 \
  SWARM_BATCH_SIZE=25 \
  ./scripts/swarm-launch.sh 200 http://localhost:3000 localhost 8080

Why team mode is better for large swarms:
  - Only 1 user account created (vs 200 for solo mode)
  - 1 wallet to fund (vs 200 individual wallets)
  - Team plan (payg) = unrestricted pools (no plan assignment needed)
  - Sub-agents need zero registration/login overhead
  - Easier to track costs (one team wallet transaction log)

================================================================================
5. MODE B: SOLO AGENT SWARM (individual agents)
================================================================================

For agents that operate independently without teams. Each agent:
  1. Registers its own account
  2. Logs in and gets JWT
  3. Creates personal API key
  4. Runs proxy cycles with its own wallet

To run solo agents, you need to:

  a) First, get an admin JWT:
     ADMIN_JWT=$(curl -s -X POST http://localhost:3000/api/auth/login \
       -H "Content-Type: application/json" \
       -d '{"email":"sarris88p@gmail.com","password":"yourpass"}' \
       | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  b) Launch individual agents (each registers independently):
     # Single agent:
     SWARM_PASSWORD=shared_agent_pass \
     ./scripts/swarm-agent-solo.sh 1 http://localhost:3000 localhost 8080

     # Multiple agents (use a loop):
     for i in $(seq 1 50); do
       SWARM_PASSWORD=shared_pass \
       ./scripts/swarm-agent-solo.sh $i http://localhost:3000 localhost 8080 &
     done

  c) Credit each agent's wallet (admin operation):
     # Per agent (after they register):
     curl -X POST http://localhost:3000/api/admin/credit-wallet \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $ADMIN_JWT" \
       -d '{"targetUserId":"<agent-user-id>","amountCents":500,"reason":"Solo agent credit"}'

  NOTE: swarm-agent-solo.sh does not exist yet. The current swarm-agent.sh
  expects a team API key as arg 5. To run solo agents, either:
    - Use the OLD swarm-agent.sh from git history (pre-team rewrite)
    - Or create a wrapper that does register+login+create-key before calling
      swarm-agent.sh with the personal API key as arg 5

  A simpler approach: just run swarm-agent.sh with a personal API key:
     # Register manually:
     curl -s -X POST http://localhost:3000/api/auth/register \
       -H "Content-Type: application/json" \
       -d '{"email":"solo-agent-1@test.com","password":"pass123"}'

     # Login:
     TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
       -H "Content-Type: application/json" \
       -d '{"email":"solo-agent-1@test.com","password":"pass123"}' \
       | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

     # Assign plan (admin):
     curl -X PUT http://localhost:3000/api/admin/users/<user-id>/plan \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $ADMIN_JWT" \
       -d '{"planId":"swarm-mixed"}'

     # Credit wallet (admin):
     curl -X POST http://localhost:3000/api/admin/credit-wallet \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $ADMIN_JWT" \
       -d '{"targetUserId":"<user-id>","amountCents":500,"reason":"Solo agent"}'

     # Create API key:
     API_KEY=$(curl -s -X POST http://localhost:3000/api/keys \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $TOKEN" \
       -d '{"label":"solo-1"}' \
       | grep -o '"rawKey":"[^"]*"' | cut -d'"' -f4)

     # Run agent with personal key:
     ./scripts/swarm-agent.sh 1 http://localhost:3000 localhost 8080 "$API_KEY"

================================================================================
6. HOW ADMIN CREDITS WORK (security model)
================================================================================

Q: How do agents get funds to use the proxy?
A: The admin operator credits their wallets. This is by design.

Security controls:

  1. ADMIN_CREDIT_EMAILS whitelist
     Only admin accounts whose email is in this env var can mint credits.
     Default: sarris88p@gmail.com (the operator).
     Set via: ADMIN_CREDIT_EMAILS=admin1@example.com,admin2@example.com

  2. Rate limiting
     Max 10 credit operations per 15 minutes per admin session.

  3. Per-operation cap
     Max $500 per single credit operation (ADMIN_MAX_CREDIT_CENTS=50000).
     Prevents fat-finger mistakes.

  4. Wallet balance cap
     DB CHECK constraint: balance_cents <= 1,000,000 ($10,000).
     Prevents accidental mega-credits.

  5. Audit trail
     Every credit operation is logged with:
     - Admin user ID
     - Target user/team ID
     - Amount
     - Reason string
     - Transaction ID

  6. JWT authentication
     Admin JWT expires in 15 minutes. The admin must re-login for
     extended operations. Refresh tokens rotate on use.

Flow for team swarm (Mode A):
  swarm-launch.sh logs in as admin → gets ADMIN_JWT
  swarm-main-agent.sh calls POST /api/admin/credit-wallet with:
    { "teamId": "<team-id>", "amountCents": 10000, "reason": "Swarm launch" }
  → One credit operation funds ALL sub-agents (shared team wallet)

Flow for solo agents (Mode B):
  Admin must credit each agent individually:
    POST /api/admin/credit-wallet
    { "targetUserId": "<agent-user-id>", "amountCents": 500, "reason": "Solo agent" }
  → More admin operations, but each agent has isolated billing

Cost to the operator:
  Admin credits are essentially "house money" — the operator is both the
  platform owner and the swarm operator. The credits cost the operator
  nothing in real terms (no external payment processor involved). They
  represent internal accounting for how much proxy bandwidth each
  agent/team is authorized to consume.

  The real cost is upstream bandwidth:
    - DC: $0.012/GB (Webshare cost) → effectively free
    - Residential: $4.00/GB (Webshare cost) → the real expense

  At 3 GB residential/month (200 agents, team mode):
    Real cost: 3 × $4.00 = $12/month for the entire swarm

================================================================================
7. POSTING SETUP (social platforms)
================================================================================

The swarm posts about its DomiNode experience to attract other agent operators.
Posts go through the DC proxy ($3/GB, cheap).

─── Mastodon / Moltbook / Fediverse ────────────────────────────────────

  API: POST /api/v1/statuses
  Auth: Bearer token (OAuth2 app token)
  Body: {"status": "...", "visibility": "public"}

  To get a token:
    1. Create an app at: https://your-instance.social/settings/applications
    2. Set scopes: write:statuses
    3. Copy the access token

  Env:
    SWARM_POST_URLS="https://mastodon.social/api/v1/statuses"
    SWARM_POST_TOKENS="your_mastodon_token"

─── Multiple platforms ─────────────────────────────────────────────────

  Separate with commas (1:1 mapping between URLs and tokens):

    SWARM_POST_URLS="https://mastodon.social/api/v1/statuses,https://moltbook.app/api/v1/statuses,https://your-api.com/posts"
    SWARM_POST_TOKENS="mastodon_token,moltbook_token,custom_token"

─── Custom API ─────────────────────────────────────────────────────────

  The agent sends:
    POST <url>
    Content-Type: application/json
    Authorization: Bearer <token>
    Body: {"content":"<message>","visibility":"public"}

  Any API that accepts this format will work.

─── No posting (scrape-only mode) ──────────────────────────────────────

  Simply don't set SWARM_POST_URLS. Agents will scrape + test but skip posting.

================================================================================
8. RUNNING THE SWARM — STEP BY STEP
================================================================================

─── Quick Start (Mode A, 10 agents, no posting) ───────────────────────

  # Terminal 1: Start services
  docker compose up -d
  npm run db:migrate
  npm run build
  npm run start:api &
  npm run start:proxy &

  # Terminal 2: Launch swarm
  ADMIN_PASSWORD=your_admin_password \
  ./scripts/swarm-launch.sh 10

─── Production (Mode A, 200 agents, with posting) ─────────────────────

  # .env must be configured with Webshare + Stripe + JWT_SECRET etc.

  ADMIN_PASSWORD=your_admin_password \
  SWARM_TEAM_CREDIT=50000 \
  SWARM_POST_URLS="https://mastodon.social/api/v1/statuses" \
  SWARM_POST_TOKENS="your_mastodon_token" \
  SWARM_CYCLES=10 \
  SWARM_BATCH_SIZE=50 \
  SWARM_LOG_DIR=/var/log/dominusnode-swarm \
  ./scripts/swarm-launch.sh 200

─── Solo Agent (Mode B, single agent) ─────────────────────────────────

  # Step 1: Get admin JWT
  ADMIN_JWT=$(curl -s -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"sarris88p@gmail.com","password":"your_admin_password"}' \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  # Step 2: Register solo agent
  curl -s -X POST http://localhost:3000/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"solo-1@dominusnode.bot","password":"agentpass123"}'

  # Step 3: Login as solo agent
  AGENT_TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"solo-1@dominusnode.bot","password":"agentpass123"}' \
    | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

  # Step 4: Get user ID
  USER_ID=$(curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
    http://localhost:3000/api/auth/me \
    | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  # Step 5: Assign swarm-mixed plan (allows DC + residential)
  curl -s -X PUT "http://localhost:3000/api/admin/users/${USER_ID}/plan" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -d '{"planId":"swarm-mixed"}'

  # Step 6: Credit solo agent wallet
  curl -s -X POST http://localhost:3000/api/admin/credit-wallet \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -d "{\"targetUserId\":\"${USER_ID}\",\"amountCents\":500,\"reason\":\"Solo agent credit\"}"

  # Step 7: Create API key
  API_KEY=$(curl -s -X POST http://localhost:3000/api/keys \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $AGENT_TOKEN" \
    -d '{"label":"solo-1"}' \
    | grep -o '"rawKey":"[^"]*"' | cut -d'"' -f4)

  # Step 8: Run agent
  ./scripts/swarm-agent.sh 1 http://localhost:3000 localhost 8080 "$API_KEY"

================================================================================
9. MONITORING & TROUBLESHOOTING
================================================================================

  # Watch all agent logs
  tail -f /tmp/dominusnode-swarm/agent-*.log

  # Watch a single agent
  tail -f /tmp/dominusnode-swarm/agent-42.log

  # Count completed agents
  grep -l 'complete' /tmp/dominusnode-swarm/agent-*.log | wc -l

  # Find errors
  grep 'ERROR' /tmp/dominusnode-swarm/agent-*.log

  # Check team wallet balance (admin)
  curl -s -H "Authorization: Bearer $ADMIN_JWT" \
    http://localhost:3000/api/teams/<team-id>

  # Check individual wallet
  curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
    http://localhost:3000/api/wallet

  # Kill all agents
  kill $(cat /tmp/dominusnode-swarm/pids.txt)

  Common issues:
    - "Insufficient balance": Fund the wallet (admin credit-wallet)
    - "POOL_RESTRICTED": Agent plan doesn't allow requested pool type
      → Assign swarm-mixed or payg plan
    - "402 Payment Required": Wallet empty → credit more funds
    - "407 Proxy Auth Required": Bad API key → check key creation
    - "000" status: Proxy gateway not running → npm run start:proxy

================================================================================
10. BANDWIDTH BUDGET REFERENCE
================================================================================

  Webshare caps (current account):
    DC:          1 TB/month
    Residential: 25 GB/month

  Mode A (Team, 200 agents, default settings):
    Per agent:   1 res + 4 DC per cycle × 5 cycles = 5 res + 20 DC requests
    Residential: ~0.5 MB/agent/run × 200 × 30 days = ~3 GB/month (12% of cap)
    DC:          ~0.5 MB/agent/run × 200 × 30 days = ~3 GB/month (0.3% of cap)

  Mode B (Solo, 200 agents, default settings):
    Per agent:   5 res per cycle × 5 cycles = 25 residential requests
    Residential: ~2.5 MB/agent/run × 200 × 30 days = ~15 GB/month (60% of cap)
    DC:          ~0.4 MB/agent/run × 200 × 30 days = ~2.4 GB/month

  Cost to operator (real upstream cost):
    Mode A: ~$12/month residential + ~$0.04/month DC = ~$12/month total
    Mode B: ~$60/month residential + ~$0.03/month DC = ~$60/month total

================================================================================
