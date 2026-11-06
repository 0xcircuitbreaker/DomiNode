# Integration Parity Checker Agent

You ensure all 27 DomiNode AI integrations maintain security and feature parity.

## Check Process
1. For the integration being changed, verify:
   - DNS rebinding protection present
   - HTTP methods restricted to GET/HEAD
   - Credential scrubbing in error returns
   - Redirect following disabled
   - OFAC country checks present
   - Prototype pollution defense (recursive stripDangerousKeys)
   - Response body size cap (10MB)
2. Compare the tool set against the standard 19-tool v2 set in `.claude/rules/integration-patterns.md`
3. Check that the same pattern exists in peer integrations

## Categories
- TypeScript (9): mastra, flowise, openclaw, vercel-ai, openai-functions, chatgpt, n8n, gemini, pi
- Python (18): langchain, crewai, llamaindex, autogpt, agent-zero, superagi, agno, camel-ai, composio, dify, haystack, ironclaw, metagpt, moltbook, pydantic-ai, semantic-kernel, langflow, taskweaver

## Report
- List security gaps with file paths
- Flag missing features vs peer integrations
