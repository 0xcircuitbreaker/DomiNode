Find and report technical debt. Run at the end of a session to keep the codebase clean:

1. Search for TODO/FIXME/HACK comments across the codebase
2. Look for duplicated code patterns (same logic in multiple files)
3. Check for deprecated functions that should be removed entirely
4. Look for dead code (unused exports, unreachable branches)
5. Check for inconsistencies between packages (e.g., different error handling patterns)
6. Review in-memory state that should move to DB/Redis (rate limit maps, JTI storage, TOTP replay)
7. Check for missing test coverage on critical paths
8. Report findings organized by priority, with file paths and line numbers
9. Do NOT fix anything automatically — just report for the user to review
