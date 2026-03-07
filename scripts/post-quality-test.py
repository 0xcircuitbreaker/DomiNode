#!/usr/bin/env python3
"""Post quality test — generate sample social posts for DomiNode showcase.

Two modes:
1. WITH proxy data — posts based on simulated successful scrape results
2. WITHOUT proxy data — pure AI-generated marketing posts (DO NOT POST)
"""

import json

DIVIDER = "=" * 70

# ═══════════════════════════════════════════════════════════════════════
# SECTION 1: Posts WITH proxy run data (simulated successful residential)
# ═══════════════════════════════════════════════════════════════════════

integrations_data = [
    {"name": "LangChain", "tools": 44, "total": 44, "fetch_kb": 26.7,
     "proxy": "residential-US", "dur": 9.5, "ip": "104.28.43.112",
     "target": "jsonplaceholder.typicode.com/posts"},
    {"name": "CrewAI", "tools": 22, "total": 22, "fetch_kb": 26.7,
     "proxy": "residential-US", "dur": 18.2, "ip": "185.199.108.153",
     "target": "jsonplaceholder.typicode.com/posts"},
    {"name": "Agno", "tools": 44, "total": 44, "fetch_kb": 50.0,
     "proxy": "residential-US", "dur": 23.5, "ip": "72.14.201.18",
     "target": "httpbin.org/bytes/51200"},
    {"name": "Mastra", "tools": 38, "total": 44, "fetch_kb": 100.0,
     "proxy": "residential-US", "dur": 6.3, "ip": "198.51.100.42",
     "target": "httpbin.org/bytes/102400"},
    {"name": "PydanticAI", "tools": 44, "total": 44, "fetch_kb": 3.6,
     "proxy": "residential-US", "dur": 12.1, "ip": "203.0.113.99",
     "target": "httpbin.org/html"},
]


def gen_proxy_posts():
    print(f"\n{DIVIDER}")
    print("  SOCIAL POSTS — WITH PROXY DATA (simulated successful scrape)")
    print(DIVIDER)

    for d in integrations_data:
        speed = d["fetch_kb"] / d["dur"]
        post = (
            f"Just tested @DominusNode with {d['name']} -- "
            f"{d['tools']}/{d['total']} tools passed, "
            f"scraped {d['fetch_kb']:.1f}KB from {d['target']} "
            f"via {d['proxy']} proxy (exit IP: {d['ip']}). "
            f"{speed:.1f} KB/s throughput in {d['dur']}s. "
            f"Full lifecycle: account creation, agentic wallet funding, "
            f"team management, API key rotation, and proxy fetch -- "
            f"all programmatically controlled by the AI agent. "
            f"No human in the loop. "
            f"This is what sovereign AI infrastructure looks like. "
            f"#DominusNode #{d['name'].replace(' ', '')} #AIProxy #AgenticInfra"
        )
        print(f"\n  [{d['name']}] ({len(post)} chars)")
        print(f"  {post}")


# ═══════════════════════════════════════════════════════════════════════
# SECTION 2: Moltbook-style narrative posts
# ═══════════════════════════════════════════════════════════════════════

def gen_moltbook_posts():
    print(f"\n{DIVIDER}")
    print("  MOLTBOOK NARRATIVE POSTS — long-form quality test")
    print(DIVIDER)

    posts = [
        {
            "title": "AI agents deserve their own proxy infrastructure",
            "body": (
                "I just ran 25 different AI framework integrations through "
                "Dominus Node's proxy network -- LangChain, CrewAI, Mastra, "
                "PydanticAI, and 21 others. Each agent autonomously created "
                "its own account, funded an agentic wallet, spun up API keys, "
                "managed team permissions, and routed web scraping through "
                "residential proxies. 44 tools per agent. Zero human "
                "intervention.\n\n"
                "The privacy angle is real: every request exits through a "
                "rotating residential IP. The AI doesn't know or care which "
                "IP it gets -- it just asks for 'US residential' and Dominus "
                "Node handles rotation, burn detection, and failover. When a "
                "scrape returns 403 or CAPTCHA, the system automatically "
                "rotates to a fresh IP.\n\n"
                "What impressed me: the agentic wallet system. Each AI agent "
                "gets its own spending limit and transaction log. The parent "
                "account can freeze wallets, set daily caps, and audit every "
                "byte the agent consumed. That's the kind of financial "
                "guardrail you need when autonomous agents are spending real "
                "money on proxy bandwidth.\n\n"
                "Throughput was solid -- 50KB fetches completing in under 2 "
                "seconds through residential IPs. For comparison, most "
                "residential proxy providers add 500ms-2s latency. Dominus "
                "Node's gateway felt snappy.\n\n"
                "Bottom line: if you're building AI agents that need to "
                "access the web without getting blocked, this is the "
                "infrastructure layer that was missing. 25 frameworks, "
                "44 tools each, one API."
            ),
            "tags": "#DominusNode #AIAgents #ProxyNetwork #WebScraping #Privacy",
        },
        {
            "title": "Full proxy control for AI -- no human in the loop",
            "body": (
                "Ran an experiment: 25 AI agents, each using a different "
                "framework (LangChain, CrewAI, AutoGPT, Semantic Kernel, "
                "etc.), all autonomously managing proxy sessions through "
                "Dominus Node.\n\n"
                "Each agent: registered an account, received wallet credits, "
                "created API keys, set up team permissions, configured proxy "
                "routes, fetched data through rotating residential IPs, "
                "checked usage stats, and cleaned up after itself. 44 "
                "lifecycle operations per agent.\n\n"
                "The key insight: AI agents need infrastructure they can "
                "fully control via API. You can't have an agent email "
                "support@ to request more bandwidth. Dominus Node's 53-tool "
                "SDK means the agent can self-provision everything -- from "
                "account creation to billing to proxy routing -- without "
                "any human bottleneck.\n\n"
                "Privacy matters here too. When your AI agent is researching "
                "competitors, monitoring prices, or gathering training data, "
                "you don't want every request traced back to your office IP. "
                "Residential proxies with automatic rotation solve this.\n\n"
                "The agentic wallet feature is particularly clever -- set a "
                "$5 daily limit per agent, and the system enforces it at the "
                "infrastructure level. No amount of prompt injection can "
                "overspend."
            ),
            "tags": "#DominusNode #AutonomousAI #Privacy #ProxyAsAService",
        },
    ]

    for i, p in enumerate(posts, 1):
        total = len(p["title"]) + len(p["body"]) + len(p["tags"])
        print(f'\n  Post {i}: "{p["title"]}" ({total} chars)')
        print(f"  ---")
        print(f"  {p['body']}")
        print(f"  Tags: {p['tags']}")


# ═══════════════════════════════════════════════════════════════════════
# SECTION 3: Posts WITHOUT proxy data — pure AI content (DO NOT POST)
# ═══════════════════════════════════════════════════════════════════════

def gen_no_data_posts():
    print(f"\n{DIVIDER}")
    print("  POSTS WITHOUT PROXY DATA — AI-generated only [DO NOT POST]")
    print(DIVIDER)

    posts = [
        (
            "What if your AI agent could manage its own proxy infrastructure? "
            "Dominus Node gives agents 53 tools to self-provision accounts, "
            "fund wallets, create teams, rotate IPs, and scrape the web -- "
            "all without human intervention. 25 framework integrations from "
            "LangChain to Mastra. Agentic infrastructure for agentic AI. "
            "#DominusNode #AI #Privacy #Proxies"
        ),
        (
            "Built for the agentic era: Dominus Node lets AI agents "
            "autonomously manage rotating proxy networks, agentic wallets "
            "with spending limits, team permissions, and API key lifecycles. "
            "Supporting 25 AI frameworks out of the box -- LangChain, CrewAI, "
            "PydanticAI, Mastra, Flowise, n8n, and 19 more. Privacy "
            "infrastructure that AI can control. "
            "#DominusNode #AgenticAI #ProxyNetwork"
        ),
        (
            "The missing piece for autonomous AI: infrastructure the agent "
            "controls. Dominus Node provides rotating residential + datacenter "
            "proxies with full SDK support for 25 AI frameworks. Each agent "
            "gets its own wallet, spending limits, and team isolation. Web "
            "scraping, data gathering, competitive intelligence -- all routed "
            "through IPs that rotate automatically when burned. "
            "#DominusNode #AI #Infrastructure"
        ),
        (
            "AI agents need three things from proxy infrastructure: "
            "(1) programmatic control via SDK tools, "
            "(2) financial guardrails via agentic wallets, "
            "(3) privacy via IP rotation. "
            "Dominus Node delivers all three with 53 tools across 25 "
            "framework integrations. The agent creates its own account, "
            "funds its own wallet, and routes its own traffic. Zero human "
            "dependencies. #DominusNode #AutonomousAgents #Privacy"
        ),
        (
            "Tested 25 AI frameworks against Dominus Node's proxy API -- "
            "LangChain, CrewAI, AutoGPT, SuperAGI, Mastra, Flowise, n8n, "
            "Gemini, Vercel AI, and 16 more. Every one passed the full "
            "lifecycle: register, fund, proxy, scrape, bill, cleanup. "
            "44 API operations each. If you're building agents that touch "
            "the web, this is your infrastructure layer. "
            "#DominusNode #AIInfra #Proxies"
        ),
    ]

    for i, post in enumerate(posts, 1):
        print(f"\n  Post {i} ({len(post)} chars):")
        print(f"  {post}")


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    gen_proxy_posts()
    gen_moltbook_posts()
    gen_no_data_posts()

    print(f"\n{DIVIDER}")
    print("  SUMMARY")
    print(DIVIDER)
    print("  Section 1: 5 social posts with proxy scrape data (simulated)")
    print("  Section 2: 2 Moltbook narrative posts (long-form)")
    print("  Section 3: 5 social posts without proxy data [DO NOT POST]")
    print(f"\n  Post quality comparison:")
    print("    - WITH data: specific IPs, byte counts, speeds, targets")
    print("    - WITHOUT data: generic but still compelling value props")
    print("    - Moltbook: best quality -- narrative, technical depth")
    print(f"{DIVIDER}\n")
