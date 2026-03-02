# Dominus Node Google Gemini / Vertex AI Function Declarations

Gemini-format function declarations and handler implementations for the Dominus Node rotating proxy-as-a-service platform. These declarations allow Google Gemini and Vertex AI models to interact with Dominus Node's proxy network, wallet, agentic wallet, and team APIs via function calling.

## What This Is

This directory contains:

| File | Description |
|------|-------------|
| `functions.json` | Array of 22 Gemini `FunctionDeclaration` objects |
| `handler.ts` | TypeScript handler that dispatches function calls to the Dominus Node API |
| `handler.py` | Python handler that dispatches function calls to the Dominus Node API |

The function declarations follow the [Gemini function calling specification](https://ai.google.dev/docs/function_calling), using uppercase types (`STRING`, `INTEGER`, `OBJECT`, `BOOLEAN`, `ARRAY`) and embedding constraints in description text rather than using JSON Schema keywords like `minimum`, `maximum`, `enum`, or `default`.

## Available Functions (22)

| Function | Description | Auth Required |
|----------|-------------|---------------|
| `dominusnode_proxied_fetch` | Make an HTTP request through Dominus Node's rotating proxy network | Yes |
| `dominusnode_check_balance` | Check wallet balance (cents, USD, currency) | Yes |
| `dominusnode_check_usage` | Check usage stats for a time period (day/week/month) | Yes |
| `dominusnode_get_proxy_config` | Get proxy endpoints, supported countries, geo-targeting info | Yes |
| `dominusnode_list_sessions` | List currently active proxy sessions | Yes |
| `dominusnode_create_agentic_wallet` | Create a sub-wallet for an AI agent with spending limits | Yes |
| `dominusnode_fund_agentic_wallet` | Transfer funds from main wallet to an agentic wallet | Yes |
| `dominusnode_agentic_wallet_balance` | Check an agentic wallet's balance and status | Yes |
| `dominusnode_list_agentic_wallets` | List all agentic wallets | Yes |
| `dominusnode_agentic_transactions` | Get agentic wallet transaction history | Yes |
| `dominusnode_freeze_agentic_wallet` | Freeze an agentic wallet | Yes |
| `dominusnode_unfreeze_agentic_wallet` | Unfreeze an agentic wallet | Yes |
| `dominusnode_delete_agentic_wallet` | Delete an agentic wallet (refunds balance) | Yes |
| `dominusnode_create_team` | Create a team for shared proxy billing | Yes |
| `dominusnode_list_teams` | List teams you belong to | Yes |
| `dominusnode_team_details` | Get team details | Yes |
| `dominusnode_team_fund` | Fund a team wallet | Yes |
| `dominusnode_team_create_key` | Create a shared team API key | Yes |
| `dominusnode_team_usage` | Get team wallet transaction history | Yes |
| `dominusnode_update_team` | Update team settings | Yes |
| `dominusnode_update_team_member_role` | Update a team member's role | Yes |
| `dominusnode_topup_paypal` | Create a PayPal wallet top-up session | Yes |

## Usage with Google Gemini (Python)

```python
import json
import google.generativeai as genai
from handler import create_dominusnode_function_handler

# Load Gemini function declarations
with open("functions.json") as f:
    declarations = json.load(f)

# Create the Dominus Node handler
dominusnode = create_dominusnode_function_handler(
    api_key="dn_live_your_api_key_here",
    base_url="https://api.dominusnode.com",
)

# Configure Gemini with function declarations
genai.configure(api_key="YOUR_GEMINI_API_KEY")
model = genai.GenerativeModel(
    "gemini-2.0-flash",
    tools=[{"function_declarations": declarations}],
)

# Start a chat
chat = model.start_chat()
response = chat.send_message("What is my Dominus Node proxy balance?")

# Handle function calls
for part in response.parts:
    if fn := part.function_call:
        result = await dominusnode(fn.name, dict(fn.args))
        response = chat.send_message(
            genai.protos.Content(
                parts=[
                    genai.protos.Part(
                        function_response=genai.protos.FunctionResponse(
                            name=fn.name,
                            response={"result": json.loads(result)},
                        )
                    )
                ]
            )
        )
        print(response.text)
```

## Usage with Vertex AI (Python)

```python
import json
import vertexai
from vertexai.generative_models import GenerativeModel, Tool, FunctionDeclaration
from handler import create_dominusnode_function_handler

# Load function declarations
with open("functions.json") as f:
    declarations = json.load(f)

# Convert to Vertex AI FunctionDeclaration objects
vertex_declarations = [
    FunctionDeclaration(
        name=d["name"],
        description=d["description"],
        parameters=d["parameters"],
    )
    for d in declarations
]

# Create handler and model
dominusnode = create_dominusnode_function_handler(api_key="dn_live_your_key")
vertexai.init(project="your-project", location="us-central1")
model = GenerativeModel(
    "gemini-2.0-flash",
    tools=[Tool(function_declarations=vertex_declarations)],
)

# Use in a chat session
chat = model.start_chat()
response = chat.send_message("Check my proxy usage this week")
# ... handle function calls as above
```

## Usage with TypeScript / Node.js

```typescript
import { readFileSync } from "fs";
import { createDominusNodeFunctionHandler } from "./handler";

// Load function declarations
const declarations = JSON.parse(readFileSync("functions.json", "utf-8"));

// Create the handler
const handler = createDominusNodeFunctionHandler({
  apiKey: "dn_live_your_api_key_here",
  baseUrl: "https://api.dominusnode.com",
});

// Example: direct function call
const balance = await handler("dominusnode_check_balance", {});
console.log(JSON.parse(balance));

// Example: proxied fetch with geo-targeting
const fetchResult = await handler("dominusnode_proxied_fetch", {
  url: "https://httpbin.org/ip",
  method: "GET",
  country: "US",
  proxy_type: "residential",
});
console.log(JSON.parse(fetchResult));

// Example: PayPal top-up
const topup = await handler("dominusnode_topup_paypal", {
  amount_cents: 5000,  // $50.00
});
console.log(JSON.parse(topup));
```

## Gemini Schema Restrictions

Gemini function declarations differ from OpenAI's JSON Schema format:

| Feature | OpenAI/JSON Schema | Gemini |
|---------|-------------------|--------|
| Type names | `"string"`, `"integer"` | `"STRING"`, `"INTEGER"` |
| `default` | Supported | Not supported -- moved to description |
| `minimum`/`maximum` | Supported | Not supported -- moved to description |
| `enum` | Supported | Not supported -- listed in description |
| `minLength`/`maxLength` | Supported | Not supported -- moved to description |
| `additionalProperties` | Supported | Not supported -- omitted |

All constraints are expressed in the `description` field text for Gemini compatibility.

## Security

### SSRF Prevention

Both handlers include comprehensive SSRF prevention that blocks:

- **Private IP ranges**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 0.0.0.0/8, 169.254.0.0/16, 100.64.0.0/10 (CGNAT)
- **Non-standard IP representations**: Hex (0x7f000001), octal (0177.0.0.1), decimal integer (2130706433)
- **IPv6 private ranges**: ::1, fc00::/7, fe80::/10, ::ffff:-mapped private IPs
- **Internal hostnames**: .localhost, .local, .internal, .arpa TLDs
- **Protocol restriction**: Only http:// and https:// are allowed
- **DNS rebinding protection**: Resolves hostnames and checks all IPs

### Sanctioned Countries (OFAC)

Requests targeting CU, IR, KP, RU, SY are blocked at the handler level.

### Input Validation

- Integer overflow protection: amount/limit values capped at 2,147,483,647
- Label length validation: max 100 characters
- Control character blocking in labels and names
- URL-encoding of path parameters to prevent path traversal
- Prototype pollution prevention in JSON parsing
- Response body size limit: 10 MB max
- HTTP method restriction: only GET, HEAD, OPTIONS for proxied fetch

### Credential Scrubbing

API keys (`dn_live_*`, `dn_test_*`) are scrubbed from all error messages returned to the LLM.

## Proxy Pricing

| Proxy Type | Price | Best For |
|------------|-------|----------|
| Datacenter (`dc`) | $3.00/GB | General scraping, speed-critical tasks |
| Residential | $5.00/GB | Anti-detection, geo-restricted content |

## Dependencies

### TypeScript Handler
- Node.js 18+ (uses native `fetch` and `AbortSignal.timeout`)
- No external dependencies

### Python Handler
- Python 3.8+
- `httpx` (`pip install httpx`)

## Related Integrations

- `integrations/openai-functions/` -- OpenAI-compatible function schemas (21 functions)
- `integrations/langchain/` -- LangChain tools integration
- `integrations/vercel-ai/` -- Vercel AI SDK provider
- `integrations/crewai/` -- CrewAI tools integration
- `integrations/openclaw/` -- OpenClaw plugin
- `packages/mcp-server/` -- Model Context Protocol server (56 tools)
- `sdks/node/` -- Full Node.js SDK
- `sdks/python/` -- Full Python SDK
