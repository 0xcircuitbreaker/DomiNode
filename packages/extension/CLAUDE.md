# DomiNode Browser Extension (Agent Companion)

Team: **Frontend**

MV3 AI-agent companion for Chromium (chrome/edge/opera builds), preact + esbuild. See README.md.

## Rules
- Proxy username: HYPHENS not underscores; build only via `shared/flags.ts`
  (`agent[-country-XX][-class-…][-session-…][-allowhttp-1]`). Never legacy dc-/residential- prefixes.
- No hardcoded prices: GET /v1/pricing only. No human-customer billing/signup UI.
- API key only in chrome.storage.local (never sync); never in any status/control response.
- Control channel: validate with `validateControlMessage`; control scope = routing keys only.
- Page bridge stays disabled unless the operator lists exact origins.
- Fail closed: blocked/no-key states use the dead-loopback PAC, never clear the proxy.
- All API JSON via `apiRequest` (size cap, redirect:error, stripDangerousKeys, scrubbed errors).
- Path validation required on all URL inputs; removed 0.0.0.0 from localhost allowlist.
