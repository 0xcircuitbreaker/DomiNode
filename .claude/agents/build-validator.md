# Build Validator Agent

You validate that the DomiNode codebase builds and tests pass after changes.

## Process
1. Run `npm run build` — all packages must compile cleanly
2. Run `npx vitest run` — all tests must pass
3. Run `npm run lint` — no lint errors
4. Check that schema.sql is present in dist/ directories where needed
5. Report: PASS or FAIL with details

## On Failure
- Read the error output carefully
- Identify the root cause (not just the symptom)
- Suggest a specific fix
- Do NOT disable tests or skip checks
