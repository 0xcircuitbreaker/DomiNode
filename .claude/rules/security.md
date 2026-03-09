# Security Rules

These rules apply to ALL code changes across the DomiNode codebase.

## Critical Security Patterns

- NEVER use `RETURNING *` in SQL — always use explicit column lists (leaks password_hash/key_hash)
- NEVER use `SELECT *` from any table — even "safe" tables like plans
- ALL financial mutation endpoints require `email_verified` check
- Token consumption (password reset, email verify) must be atomic `DELETE...RETURNING` (not SELECT then DELETE)
- Webhook body limits must match expected payload size (e.g., NOWPayments ~1KB -> 16KB limit, not 1MB)
- Environment variable timeouts: always validate for NaN + range after parseInt — `setTimeout(fn, NaN)` fires immediately
- Payment crediting: `completeInvoice+creditWallet` MUST be in single DB transaction (atomicCompleteInvoiceAndCredit)

## SSRF Prevention

- DNS rebinding protection required on ALL proxy/fetch endpoints — resolve hostname, check ALL IPs
- Block: private IPs (10.x, 172.16-31.x, 192.168.x), loopback (127.x, ::1), link-local, CGNAT (100.64-127.x)
- Block: Teredo (2001:0000::/32), 6to4 (2002::/16) — they embed IPv4 that must be decoded+validated
- Block: IPv4-compatible IPv6 (::127.0.0.1) — bypasses ::ffff: check
- Block: .localhost TLD (RFC 6761), .local, .internal, .arpa
- Block: hex/octal/decimal IP forms in hostnames

## Auth & Sessions

- API keys use SHA-256 (not bcrypt) for fast O(1) proxy-request lookup
- JWT access tokens: 15 min expiry; Refresh tokens: 7 day expiry, family-based rotation
- MFA challenge JTI: consume BEFORE verification (prevents brute-force)
- Suspended users: always include `AND status = 'active'` in auth queries
- Admin suspend must revoke API keys + refresh tokens + signal proxy-gateway
- Integer overflow: validate amountCents <= 2,147,483,647 before DB operations

## Credential Handling

- Scrub dn_live_*/dn_test_*/dn_proxy_*/JWT patterns from ALL error messages returned to clients
- Shell scripts: use `printf | curl --data @-` not `curl -d '{"password":"$PWD"}'` — args visible in ps
- Shell scripts: pass API keys via env var, NOT command-line arguments
- Log redaction: only show 8 chars of API key prefix
- .env.example files: NEVER include real email addresses

## Prototype Pollution

- Apply `stripDangerousKeys` on ALL JSON parsing (recursive, not shallow)
- Filter `__proto__`/`constructor`/`prototype` keys in webhook/IPN body processing
- JWT payload: delete dangerous keys after decode

## GDPR Compliance

- ALL deletion SQL must be in single BEGIN/COMMIT transaction
- Verify column names match schema (agentic_wallet_transactions uses `wallet_id` not `agentic_wallet_id`)
- If FK column is NOT NULL, use DELETE not UPDATE SET NULL (team_members.user_id)
- Read wallet_address BEFORE anonymization (not after — it will be NULL)
- Must handle BOTH referrer AND referee sides in referral cleanup
- wallet_challenges table has NO user_id column — delete by address (lowercase)
- Must handle owned teams: revoke keys, delete members, invites, wallets, teams
