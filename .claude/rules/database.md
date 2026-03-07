# Database Rules

## PostgreSQL Conventions

- Balance stored in cents (integer) with DB CHECK >= 0 AND <= 1000000 (ceiling prevents overflow)
- amount_cents upper bound: <= 214748364 (prevents integer overflow)
- schema.sql must be copied to dist/ after every build (migrate script reads from dist/)
- All CHECK constraints need BOTH floor AND ceiling bounds
- TEXT columns with hashes: CHECK(length(col)=64) for SHA-256 hex

## TOCTOU Prevention

- getUserPlan: call once per session, hoist plan fields to outer scope
- Plan lookup failure must FAIL CLOSED (reject) not graceful degrade
- All check-then-act patterns must use BEGIN/COMMIT transactions
- Role check queries inside transactions must use FOR UPDATE
- Agentic wallet createWallet: count check + insert must be atomic
- createInvite/cancelInvite/createTeamApiKey/revokeTeamApiKey: all need transactions with FOR UPDATE
- Loyalty rewards: use FOR UPDATE SKIP LOCKED per-reward in a loop

## Repository Layer

- RETURNING clause in INSERT must omit sensitive columns (code_hash, password_hash, key_hash)
- SELECT queries must use explicit column lists, never *
- connectWithRetry must be exported AND called in every service's main.ts entrypoint
- Batch processing: acquire fresh DB client per iteration (pool.connect/release)
- Batch processing caps: LIMIT 1000 on pending queries to prevent unbounded processing

## In-Memory State

- In-memory Maps for rate limiting must have size caps AND periodic cleanup intervals
- freeReservations/in-memory Maps: MAX_FREE_RESERVATIONS=100k cap
- MFA JTI storage and TOTP replay: currently in-memory (known limitation, should move to DB/Redis)
