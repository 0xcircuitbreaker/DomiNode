# @dominusnode/shared

Team: **Core Platform**

The shared foundation package. Types, DB client, auth, schema, repositories used by ALL other packages.

## Key Files
- `src/types.ts` — User, ApiKey, Wallet, Session, UsageRecord, constants
- `src/db.ts` — pg.Pool singleton, query() helper
- `src/auth.ts` — API key gen (SHA-256), bcrypt passwords, JWT (15min access, 7d refresh)
- `src/schema.sql` — Full PostgreSQL DDL (MUST be copied to dist/ after build)
- `src/repositories/` — user-repo, wallet-repo, usage-repo, team-repo, referral-repo, etc.

## Rules
- NEVER use `RETURNING *` — always explicit column lists
- NEVER use `SELECT *` — even on "safe" tables
- All check-then-act functions MUST use BEGIN/COMMIT + FOR UPDATE
- `connectWithRetry` must be exported AND called in every service's main.ts
- Balance in cents (integer), CHECK >= 0 AND <= 1000000
- API keys: SHA-256 hash stored, `dn_live_` / `dn_test_` prefix
- JWT payload: strip `__proto__`/`constructor`/`prototype` after decode
- Suspended users: `AND status = 'active'` in ALL auth queries
- Token consumption: atomic DELETE...RETURNING (never SELECT then DELETE)
- Batch processing: fresh DB client per iteration, LIMIT 1000 cap

## Common Mistakes
- Forgetting to copy schema.sql to dist/ breaks migration
- Using wallet_id vs agentic_wallet_id (check schema column names exactly)
- team_members.user_id is NOT NULL — use DELETE not UPDATE SET NULL for GDPR
- wallet_challenges has NO user_id column — delete by address (lowercase)
