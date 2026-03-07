# @dominusnode/dashboard

Team: **API & Dashboard**

Express REST API server with auth, API key management, wallet, usage, team, and webhook endpoints.

## Key Files
- `src/server.ts` — Express API server setup
- `src/main.ts` — Entrypoint with graceful shutdown
- `src/middleware/auth.ts` — JWT verification middleware
- `src/routes/` — auth, keys, usage, wallet, webhooks, teams, referrals, admin

## Rules
- CSRF: getRequestHost MUST check req.app.get("trust proxy") before trusting X-Forwarded-Host
- clearCookie must use EXACT same options as setCookie — use clearAuthCookies helper
- clearAuthCookies must clear MFA challenge cookie too
- Public invite endpoints: mask email PII (first 2 chars + *** + @domain)
- Plan change + team operations: require email_verified
- router.use(requireAuth) affects ALL routes after it — order matters
- parseFloat/parseInt for env vars: always guard against NaN
- Express parametrized routes: `req.params.id` becomes `string | string[]` — cast with `as string`
- Express auth: `(req as unknown as AuthenticatedRequest)` double-cast for TS strict
- Admin delete: all cleanup must be INSIDE deleteUser transaction
- Admin reactivate: block reactivating "deleted" status users (GDPR zombies)
- RECAPTCHA_SCORE_THRESHOLD and MAX_REGISTERED_USERS: NaN guard required

## API Structure
- All routes under /api/ prefix
- JWT auth via middleware for protected routes
- Stripe/NOWPayments/PayPal webhooks use signature verification
- Rate limiting on auth endpoints, team invites, plan changes
