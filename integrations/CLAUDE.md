# DomiNode AI Integrations

Team: **AI & Integrations**

25+ AI framework integrations providing DomiNode proxy tools for AI agents.

## Team Responsibilities
- Maintain security parity across ALL integrations (SSRF, credential scrubbing, OFAC)
- New features added to one integration must be propagated to all others
- All integrations must pass their test suites (Python: pytest, TypeScript: vitest)
- Integration showcase swarm (scripts/swarm-showcase.py) must remain functional

## Required Security (ALL Integrations)
See `.claude/rules/integration-patterns.md` for full rules.

Key: DNS rebinding protection, GET/HEAD/OPTIONS only, credential scrubbing, redirect disabled, OFAC checks, prototype pollution defense, 10MB response cap.

## Integration Categories

### TypeScript (7)
mastra, flowise, openclaw, vercel-ai, openai-functions, n8n, gemini

### Python (17+)
langchain, crewai, llamaindex, autogpt, agent-zero, superagi, agno, camel-ai, composio, dify, haystack, ironclaw, metagpt, moltbook, pydantic-ai, semantic-kernel

### Schema-only
chatgpt (OpenAPI 3.1.0 YAML + ai-plugin.json)

## Common Mistakes
- Adding SSRF protection to one integration but missing others
- OpenClaw uses JWT Bearer auth, not x-api-key
- Gemini uses ESM dynamic import
- Dify uses DominusNodeProvider(credentials={...}) with dict params
- SuperAGI uses conftest.py pattern, not mock directory
