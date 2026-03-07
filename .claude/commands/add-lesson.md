Add a lesson learned to the appropriate rules file.

When Claude makes a mistake or you discover a new pattern:
1. Identify which domain the lesson belongs to:
   - Security issue → .claude/rules/security.md
   - Database pattern → .claude/rules/database.md
   - SDK convention → .claude/rules/sdk-patterns.md
   - Integration pattern → .claude/rules/integration-patterns.md
   - Testing issue → .claude/rules/testing.md
   - Package-specific → packages/<name>/CLAUDE.md
2. Read the target file
3. Add the lesson in the appropriate section, as a concise bullet point
4. If the lesson corrects an existing rule, update it instead of adding a duplicate
5. Confirm the addition to the user

Usage: /add-lesson <description of what went wrong and the correct pattern>
