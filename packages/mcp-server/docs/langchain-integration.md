# DomiNode + LangChain Integration Guide

Add rotating proxy capabilities to your LangChain agents and chains.

## Setup

### Option 1: MCP Tool Integration

Use DomiNode as an MCP tool server with LangChain's MCP adapter:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "dominode": {
        "command": "npx",
        "args": ["-y", "@dominode/mcp-server"],
        "env": {
            "DOMINODE_API_KEY": "dn_live_your_key_here"
        }
    }
}) as client:
    tools = client.get_tools()
    # tools now includes dominode_fetch, dominode_get_balance, etc.
```

### Option 2: Direct Proxy Integration

Use DomiNode as a proxy for LangChain's web tools:

```python
import httpx

# WARNING: Do NOT set HTTP_PROXY/HTTPS_PROXY as global environment variables.
# That routes ALL process traffic (OpenAI, DBs, telemetry) through the proxy
# and leaks your API key to every upstream destination.

# Use a scoped httpx client for ONLY the requests that need the proxy:
proxy_client = httpx.Client(
    proxy="http://user:dn_live_KEY@proxy.dominode.io:8080",
    timeout=30.0,
)
response = proxy_client.get("https://target-site.com")
```

### Option 3: Custom Tool

Create a LangChain tool that uses DomiNode for geo-targeted fetching:

```python
from langchain.tools import tool
from langchain_mcp_adapters.client import MultiServerMCPClient

@tool
async def fetch_with_proxy(url: str, country: str = "US") -> str:
    """Fetch a URL through a rotating proxy from a specific country."""
    async with MultiServerMCPClient({
        "dominode": {
            "command": "npx",
            "args": ["-y", "@dominode/mcp-server"],
            "env": {"DOMINODE_API_KEY": os.environ["DOMINODE_API_KEY"]}
        }
    }) as client:
        result = await client.call_tool("dominode", "dominode_fetch", {
            "url": url,
            "country": country
        })
        return result
```

## Use with LangGraph

```python
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic
from langchain_mcp_adapters.client import MultiServerMCPClient

model = ChatAnthropic(model="claude-sonnet-4-5-20250929")

async with MultiServerMCPClient({
    "dominode": {
        "command": "npx",
        "args": ["-y", "@dominode/mcp-server"],
        "env": {"DOMINODE_API_KEY": "dn_live_your_key_here"}
    }
}) as client:
    tools = client.get_tools()
    agent = create_react_agent(model, tools)

    result = await agent.ainvoke({
        "messages": [
            {"role": "user", "content": "Fetch httpbin.org/ip from US and JP proxies"}
        ]
    })
```

## Bootstrap Mode (No API Key)

Start without a key — let the agent create its own account:

```python
async with MultiServerMCPClient({
    "dominode": {
        "command": "npx",
        "args": ["-y", "@dominode/mcp-server"]
        # No API key — bootstrap mode
    }
}) as client:
    tools = client.get_tools()
    # Agent can call dominode_setup to create account
```

## Available Tools (24 total)

### Core Proxy
- `dominode_fetch` — Fetch URL through rotating proxy with geo-targeting

### Account Management
- `dominode_setup` — One-shot account + API key creation
- `dominode_register` — Create account
- `dominode_login` — Login to existing account
- `dominode_get_account_info` — Account details

### Billing
- `dominode_get_balance` — Wallet balance
- `dominode_pay_crypto` — Pay with BTC/ETH/XMR/SOL/ZEC
- `dominode_x402_info` — x402 pay-per-request info
- `dominode_agent_wallet_create` — Coinbase Agentic Wallet

### Monitoring
- `dominode_get_usage` — Bandwidth usage summary
- `dominode_get_active_sessions` — Active proxy sessions
- `dominode_get_proxy_status` — Network health

## Pricing

| Tier | Price | Bandwidth |
|------|-------|-----------|
| Free | $0 | 1 GB/month, 10 connections |
| Pay-as-you-go | $5/GB | Unlimited |
| Volume 100GB | $4/GB | 100 GB/month |
| Volume 1TB | $3/GB | 1 TB/month |

Crypto payments: BTC, ETH, XMR (Monero), SOL, ZEC (Zcash), USDC, USDT
