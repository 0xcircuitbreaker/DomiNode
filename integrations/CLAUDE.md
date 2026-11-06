# DomiNode AI Integrations

Team: **AI & Integrations**

27 AI framework integrations exposing the standard 19-tool v2 set (see `.claude/rules/integration-patterns.md`), built on the v2 SDKs.

## Team Responsibilities
- Maintain security parity across ALL integrations (SSRF, credential scrubbing, OFAC)
- New features added to one integration must be propagated to all others
- All integrations must pass their test suites (Python: pytest, TypeScript: vitest)

## Required Security (ALL Integrations)
See `.claude/rules/integration-patterns.md` for full rules.

Key: DNS rebinding protection, GET/HEAD only, credential scrubbing, redirect disabled, OFAC checks, prototype pollution defense, 10MB response cap.

## Integration Categories

### TypeScript (9)
mastra, flowise, openclaw, vercel-ai, openai-functions, chatgpt, n8n, gemini, pi

### Python (18)
langchain, crewai, llamaindex, autogpt, agent-zero, superagi, agno, camel-ai, composio, dify, haystack, ironclaw, metagpt, moltbook, pydantic-ai, semantic-kernel, langflow, taskweaver

(gemini and openai-functions ship both TypeScript and Python handlers.)

## Common Mistakes
- Adding SSRF protection to one integration but missing others
- OpenClaw uses JWT Bearer auth, not x-api-key
- Gemini uses ESM dynamic import
- Dify uses DominusNodeProvider(credentials={...}) with dict params
- SuperAGI uses conftest.py pattern, not mock directory
