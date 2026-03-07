# Testing Rules

## General

- Every PR needs tests: unit for logic, integration for service boundaries
- vi.clearAllMocks() does NOT clear mockResolvedValueOnce queue — unconsumed mocks leak between tests
- safeJson() pattern: res.text() + size check + JSON.parse — test mocks must provide text() not json()
- Background agents can't run Bash (auto-denied) — write files in agent, compile/test in main context

## Test Commands

```bash
npm run build              # Build all packages
npx vitest run             # Run all tests
npx vitest run --coverage  # Run with coverage
npm run lint               # Lint all packages
```

## Verification Loop

After every significant code change:
1. Build: `npm run build`
2. Test: `npx vitest run` (or package-specific test)
3. Lint: `npm run lint`
4. If tests fail, fix the root cause — don't skip or disable tests
