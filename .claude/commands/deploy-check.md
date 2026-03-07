Pre-deployment checklist. Verify everything before deploying:

1. `npm run build` — all packages compile cleanly
2. `npx vitest run` — all tests pass
3. `npm run lint` — no lint errors
4. Check for .env.example completeness — all required vars documented
5. Check schema.sql is copied to dist/ (migration requirement)
6. Check Docker files bind to 127.0.0.1 (not 0.0.0.0) for proxy ports
7. Verify no hardcoded credentials, real emails, or API keys in committed files
8. Check that all RETURNING clauses use explicit column lists
9. Run `git diff --cached` to review what's about to be committed
10. Report: READY or BLOCKED (with reasons)
