Run a security audit on recent changes. Follow this workflow:

1. Check `git diff HEAD~1` to see what changed in the last commit (or `git diff` for uncommitted changes)
2. For each changed file, analyze for:
   - RETURNING * or SELECT * (must use explicit columns)
   - Missing input validation (NaN, overflow, negative values)
   - TOCTOU race conditions (check-then-act without transactions)
   - SSRF vectors (unvalidated URLs, DNS rebinding)
   - Credential leakage (API keys, JWTs in errors/logs)
   - Prototype pollution (unsanitized JSON parsing)
   - Missing email_verified checks on financial endpoints
   - GDPR compliance (proper deletion, anonymization)
3. Rate each finding: CRITICAL / HIGH / MEDIUM / LOW
4. Fix all CRITICAL and HIGH findings immediately
5. Report remaining MEDIUM/LOW findings to the user
6. After fixing, verify: `npm run build && npx vitest run`
7. Update the appropriate `.claude/rules/` file if a new pattern was discovered
