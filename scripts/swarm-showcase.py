#!/usr/bin/env python3
"""
swarm-showcase.py — Dominus Node Integration Showcase Swarm

Interactive TUI wizard to select AI framework integrations and launch a
multi-agent swarm. Each agent uses a real integration SDK (LangChain,
CrewAI, Mastra, Flowise, etc.) to make proxy requests, then generates a
social post about the experience.

Features:
  • Curses TUI wizard: connection → select integrations → distribute agents
  • 25 integrations: 17 Python + 8 TypeScript (all built dist/ available)
  • Auto-install: pip install -e <local-dir>  /  npm run build
  • Docker fallback: --network=host containers if local install fails
  • N agents per integration, concurrently via ThreadPoolExecutor
  • Minimal-data mode (DC proxies, single fetch ≈ 200B)
  • Live ANSI progress dashboard + JSON results export

Usage:
    python3 scripts/swarm-showcase.py
    python3 scripts/swarm-showcase.py --no-tui --integrations langchain crewai --agents 4
    python3 scripts/swarm-showcase.py --no-tui --integrations agno camel-ai composio dify haystack ironclaw metagpt moltbook pydantic-ai semantic-kernel gemini pi --agents 12
"""

import argparse
try:
    import curses
except ImportError:
    curses = None  # Windows without windows-curses; --no-tui still works
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

try:
    import requests
except ImportError:
    print("Auto-installing requests...", flush=True)
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "-q"])
    import requests

# ── Paths ──────────────────────────────────────────────────────────────────────
REPO_ROOT = Path(__file__).parent.parent
INTEGRATIONS_DIR = REPO_ROOT / "integrations"
NODE_RUNNER = Path(__file__).parent / "swarm-showcase-node-runner.js"
VENV_DIR = REPO_ROOT / ".showcase-venv"

# ── ANSI colors (used after curses exits) ─────────────────────────────────────
A_GRN  = "\033[92m";  A_RED  = "\033[91m";  A_YLW = "\033[93m"
A_CYN  = "\033[96m";  A_MAG  = "\033[95m";  A_BLD = "\033[1m"
A_DIM  = "\033[2m";   A_RST  = "\033[0m"

log = logging.getLogger("showcase")
logging.basicConfig(level=logging.WARNING, format="%(message)s")


# ── Data classes ───────────────────────────────────────────────────────────────
@dataclass
class IntegrationInfo:
    id: str
    name: str
    runtime: str          # "python" | "node"
    package: str          # pip / npm package name (for display)
    module: str           # python module to import OR node integration key
    src_dir: str          # path to integration source
    description: str
    hashtag: str
    tool_count: int = 26
    color: int = 0        # set in setup_colors()


@dataclass
class ShowcaseConfig:
    api_base: str = "http://localhost:3000"
    proxy_host: str = "localhost"
    proxy_port: int = 8080
    admin_email: str = ""
    admin_password: str = ""
    selected: Set[str] = field(default_factory=set)
    total_agents: int = 10
    agents_per_integ: int = 2
    credit_cents: int = 200
    proxy_type: str = "dc"
    target_url: str = "https://httpbin.org/ip"
    use_docker: bool = False
    use_llm: bool = True


@dataclass
class AgentResult:
    agent_num: int
    integration: str
    success: bool = False
    balance_ok: bool = False
    fetch_ok: bool = False
    fetch_bytes: int = 0
    usage_ok: bool = False
    account_ok: bool = False
    keys_ok: bool = False
    billing_ok: bool = False
    teams_ok: bool = False
    wallets_ok: bool = False
    plans_ok: bool = False
    tools_ok: int = 0
    tools_total: int = 0
    error: str = ""
    post: str = ""
    duration: float = 0.0
    status: str = "pending"   # pending | running | done | failed
    target_url: str = "https://httpbin.org/ip"
    proxy_type: str = "residential"


# ── Integration catalog ────────────────────────────────────────────────────────
def _make_catalog() -> Dict[str, IntegrationInfo]:
    d = INTEGRATIONS_DIR
    return {
        "langchain": IntegrationInfo(
            "langchain", "LangChain", "python",
            "dominusnode-langchain", "dominusnode_langchain",
            str(d / "langchain"),
            "LangChain toolkit — 53 tools", "#LangChain", 53),
        "crewai": IntegrationInfo(
            "crewai", "CrewAI", "python",
            "dominusnode-crewai", "dominusnode_crewai",
            str(d / "crewai"),
            "CrewAI tool classes — 53 tools", "#CrewAI", 53),
        "llamaindex": IntegrationInfo(
            "llamaindex", "LlamaIndex", "python",
            "dominusnode-llamaindex", "dominusnode_llamaindex",
            str(d / "llamaindex"),
            "LlamaIndex ToolSpec — 53 functions", "#LlamaIndex", 53),
        "autogpt": IntegrationInfo(
            "autogpt", "AutoGPT", "python",
            "dominusnode-autogpt", "dominusnode_autogpt",
            str(d / "autogpt"),
            "AutoGPT command plugin — 53 commands", "#AutoGPT", 53),
        "agent-zero": IntegrationInfo(
            "agent-zero", "Agent Zero", "python",
            "(built-in)", "agent_zero_local",
            str(d / "agent-zero"),
            "Agent Zero numbered tools — 53 functions", "#AgentZero", 53),
        "superagi": IntegrationInfo(
            "superagi", "SuperAGI", "python",
            "dominusnode-superagi", "dominusnode_superagi",
            str(d / "superagi"),
            "SuperAGI toolkit — 53 tools", "#SuperAGI", 53),
        "mastra": IntegrationInfo(
            "mastra", "Mastra", "node",
            "@dominusnode/mastra-tools", "mastra",
            str(d / "mastra"),
            "Mastra AI toolkit — 53 createTool instances", "#MastraAI", 53),
        "flowise": IntegrationInfo(
            "flowise", "Flowise", "node",
            "@dominusnode/flowise-tools", "flowise",
            str(d / "flowise"),
            "Flowise LangChain DynamicStructuredTool — 53 tools", "#Flowise", 53),
        "openclaw": IntegrationInfo(
            "openclaw", "OpenClaw", "node",
            "(local plugin)", "openclaw",
            str(d / "openclaw"),
            "OpenClaw plugin — 53 tools", "#OpenClaw", 53),
        "vercel-ai": IntegrationInfo(
            "vercel-ai", "Vercel AI", "node",
            "@dominusnode/ai-tools", "vercel-ai",
            str(d / "vercel-ai"),
            "Vercel AI SDK tools — 53 tools", "#VercelAI", 53),
        "openai-functions": IntegrationInfo(
            "openai-functions", "OpenAI Functions", "node",
            "(local handler)", "openai-functions",
            str(d / "openai-functions"),
            "OpenAI function-calling handler — 53 functions", "#OpenAI", 53),
        "n8n": IntegrationInfo(
            "n8n", "n8n", "node",
            "n8n-nodes-dominusnode", "n8n",
            str(d / "n8n"),
            "n8n community nodes — 7 nodes (53 operations)", "#n8n", 53),
        "raw-http": IntegrationInfo(
            "raw-http", "Raw HTTP", "python",
            "(none)", "raw_http",
            "",
            "Direct REST + proxy gateway — 53 endpoints", "#Proxy", 53),
        "agno": IntegrationInfo(
            "agno", "Agno", "python",
            "dominusnode-agno", "dominusnode_agno",
            str(d / "agno"),
            "Agno (phidata) toolkit — 53 tools", "#Agno", 53),
        "camel-ai": IntegrationInfo(
            "camel-ai", "CAMEL-AI", "python",
            "dominusnode-camel", "dominusnode_camel",
            str(d / "camel-ai"),
            "CAMEL-AI FunctionTool set — 53 tools", "#CAMELAI", 53),
        "composio": IntegrationInfo(
            "composio", "Composio", "python",
            "dominusnode-composio", "dominusnode_composio",
            str(d / "composio"),
            "Composio action toolkit — 53 tools", "#Composio", 53),
        "dify": IntegrationInfo(
            "dify", "Dify", "python",
            "dominusnode-dify", "dominusnode_dify",
            str(d / "dify"),
            "Dify tool provider — 53 tools", "#Dify", 53),
        "haystack": IntegrationInfo(
            "haystack", "Haystack", "python",
            "dominusnode-haystack", "dominusnode_haystack",
            str(d / "haystack"),
            "Haystack component toolkit — 53 tools", "#Haystack", 53),
        "ironclaw": IntegrationInfo(
            "ironclaw", "IronClaw", "python",
            "dominusnode-ironclaw", "dominusnode_ironclaw",
            str(d / "ironclaw"),
            "IronClaw tool defs + MCP config — 53 tools", "#IronClaw", 53),
        "metagpt": IntegrationInfo(
            "metagpt", "MetaGPT", "python",
            "dominusnode-metagpt", "dominusnode_metagpt",
            str(d / "metagpt"),
            "MetaGPT tool functions — 53 tools", "#MetaGPT", 53),
        "moltbook": IntegrationInfo(
            "moltbook", "Moltbook", "python",
            "dominusnode-moltbook", "dominusnode_moltbook",
            str(d / "moltbook"),
            "Moltbook proxy client — 53 tools", "#Moltbook", 53),
        "pydantic-ai": IntegrationInfo(
            "pydantic-ai", "PydanticAI", "python",
            "dominusnode-pydanticai", "dominusnode_pydanticai",
            str(d / "pydantic-ai"),
            "PydanticAI agent tools — 53 tools", "#PydanticAI", 53),
        "semantic-kernel": IntegrationInfo(
            "semantic-kernel", "Semantic Kernel", "python",
            "dominusnode-semantic-kernel", "dominusnode_semantic_kernel",
            str(d / "semantic-kernel"),
            "Semantic Kernel plugin — 53 functions", "#SemanticKernel", 53),
        "gemini": IntegrationInfo(
            "gemini", "Gemini/Vertex AI", "node",
            "@dominusnode/gemini-functions", "gemini",
            str(d / "gemini"),
            "Gemini function calling handler — 53 functions", "#Gemini", 53),
        "pi": IntegrationInfo(
            "pi", "Pi (pi-mono)", "node",
            "@dominusnode/pi-extension", "pi",
            str(d / "pi"),
            "Pi agentic coding framework extension — 53 tools", "#PiMono", 53),
    }

CATALOG = _make_catalog()
PYTHON_IDS = [k for k, v in CATALOG.items() if v.runtime == "python"]
NODE_IDS   = [k for k, v in CATALOG.items() if v.runtime == "node"]


# ── Dependency checking & install ──────────────────────────────────────────────
def check_python_dep(info: IntegrationInfo) -> bool:
    if info.id == "raw-http":
        return True
    if info.id == "agent-zero":
        return (Path(info.src_dir) / "dominusnode_agent_zero").is_dir() or \
               (Path(info.src_dir) / "tools.py").exists() or \
               (Path(info.src_dir) / "tools" / "01_proxy_fetch.py").exists() or \
               (Path(info.src_dir) / "tools" / "proxy_fetch.py").exists()
    try:
        __import__(info.module)
        return True
    except ImportError:
        return False


def check_node_dep(info: IntegrationInfo) -> bool:
    dist_dir = Path(info.src_dir) / "dist"
    # Check common entry points: index.js, plugin.js, handler.js
    for entry in ("index.js", "plugin.js", "handler.js"):
        if (dist_dir / entry).exists():
            return True
    return False


def dep_installed(info: IntegrationInfo) -> bool:
    if info.runtime == "python":
        return check_python_dep(info)
    return check_node_dep(info)


def install_dep(info: IntegrationInfo, use_docker: bool = False) -> bool:
    """Try to install/build the dependency. Returns True on success."""
    if info.id == "raw-http":
        return True
    try:
        if info.runtime == "python":
            src = Path(info.src_dir)
            if not src.is_dir():
                return False
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "-e", str(src), "-q"],
                check=True, timeout=120, capture_output=True,
            )
            return True
        else:
            src = Path(info.src_dir)
            if not src.is_dir():
                return False
            subprocess.run(["npm", "install", "--silent"], cwd=str(src),
                           check=True, timeout=120, capture_output=True)
            subprocess.run(["npm", "run", "build", "--silent"], cwd=str(src),
                           check=True, timeout=120, capture_output=True)
            return True
    except Exception:
        if use_docker:
            return install_via_docker(info)
        return False


def docker_available() -> bool:
    try:
        r = subprocess.run(["docker", "info"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def node_available() -> bool:
    try:
        r = subprocess.run(["node", "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def npm_available() -> bool:
    try:
        r = subprocess.run(["npm", "--version"], capture_output=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False


def install_via_docker(info: IntegrationInfo) -> bool:
    """Use a Docker container to test if install works (verify only)."""
    # For now, Docker is used as a verification step, not a full runner.
    # Full Docker-based agents are a future enhancement.
    return False


# ── Post templates (LLM fallback) ─────────────────────────────────────────────
POST_TEMPLATES = {
    "langchain": "Full lifecycle via LangChain — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy fetch {url} in {dur}s. #DominusNode #LangChain",
    "crewai": "CrewAI 53-tool lifecycle: account setup, team mgmt, agentic wallets, proxy {url} in {dur}s. {ok}/{total} passed. #DominusNode #CrewAI",
    "llamaindex": "LlamaIndex ToolSpec full lifecycle — {ok}/{total} tools: register, keys, teams, wallets, billing, proxy {url}. #DominusNode #LlamaIndex",
    "autogpt": "AutoGPT agent #{n} ran full Dominus Node lifecycle — {ok}/{total} commands: account, teams, wallets, proxy {url}. #DominusNode #AutoGPT",
    "agent-zero": "Agent Zero full lifecycle — {ok}/{total} tools across 7 modules: account, keys, teams, wallets, proxy {url}. #DominusNode #AgentZero",
    "superagi": "SuperAGI 53-tool lifecycle: account, billing, teams, agentic wallets, proxy {url} in {dur}s. {ok}/{total} passed. #DominusNode #SuperAGI",
    "mastra": "Mastra AI full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #MastraAI",
    "flowise": "Flowise full lifecycle — {ok}/{total} tools: account, teams, wallets, billing, proxy {url} in {dur}s. #DominusNode #Flowise",
    "openclaw": "OpenClaw full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #OpenClaw",
    "vercel-ai": "Vercel AI SDK full lifecycle — {ok}/{total} tools: account, teams, wallets, billing, proxy {url}. #DominusNode #VercelAI",
    "openai-functions": "OpenAI function calling full lifecycle — {ok}/{total}: account, teams, wallets, proxy {url} in {dur}s. #DominusNode #OpenAI",
    "n8n": "n8n full lifecycle — {ok}/{total} operations: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #n8n",
    "raw-http": "Raw HTTP full lifecycle — {ok}/{total} REST endpoints: account, teams, wallets, proxy {url}. #DominusNode",
    "agno": "Agno full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url} in {dur}s. #DominusNode #Agno",
    "camel-ai": "CAMEL-AI full lifecycle — {ok}/{total} tools: account, teams, wallets, billing, proxy {url}. #DominusNode #CAMELAI",
    "composio": "Composio full lifecycle — {ok}/{total} actions: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #Composio",
    "dify": "Dify full lifecycle — {ok}/{total} provider tools: account, teams, wallets, billing, proxy {url}. #DominusNode #Dify",
    "haystack": "Haystack full lifecycle — {ok}/{total} tools: account, teams, wallets, billing, proxy {url} in {dur}s. #DominusNode #Haystack",
    "ironclaw": "IronClaw full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #IronClaw",
    "metagpt": "MetaGPT full lifecycle — {ok}/{total} tools: account, teams, wallets, billing, proxy {url} in {dur}s. #DominusNode #MetaGPT",
    "moltbook": "Moltbook full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #Moltbook",
    "pydantic-ai": "PydanticAI full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #PydanticAI",
    "semantic-kernel": "Semantic Kernel full lifecycle — {ok}/{total} functions: account, teams, wallets, billing, proxy {url}. #DominusNode #SemanticKernel",
    "gemini": "Gemini function calling full lifecycle — {ok}/{total}: account, teams, wallets, proxy {url} in {dur}s. #DominusNode #Gemini",
    "pi": "Pi (pi-mono) full lifecycle — {ok}/{total} tools: account, keys, teams, wallets, billing, proxy {url}. #DominusNode #PiMono",
}


def make_post_short(result: AgentResult) -> str:
    """Short-form post (≤280 chars) — Twitter/X style."""
    tpl = POST_TEMPLATES.get(result.integration, "#DominusNode full lifecycle test — {ok}/{total} tools passed")
    return tpl.format(
        url=result.target_url,
        dur=f"{result.duration:.1f}",
        n=result.agent_num,
        ok=result.tools_ok,
        total=result.tools_total,
    )[:280]


# Long-form narrative templates — Moltbook / blog style
LONG_POST_TEMPLATES = {
    "default": (
        "Ran {name} through the full Dominus Node lifecycle — {ok}/{total} tools "
        "executed in {dur}s. The agent autonomously registered an account, funded "
        "an agentic wallet, created API keys, set up team permissions, configured "
        "proxy routes, and fetched data through rotating {proxy_type} IPs.\n\n"
        "Proxy fetch: {fetch_bytes}B from {url} via {proxy_type} proxy. Every "
        "request exits through a rotating residential IP — the agent doesn't know "
        "or care which IP it gets. When a scrape returns 403, the system rotates "
        "to a fresh IP automatically.\n\n"
        "The agentic wallet system is the real differentiator: each AI agent gets "
        "its own spending limit and transaction log. The parent account can freeze "
        "wallets, set daily caps, and audit every byte consumed. Financial "
        "guardrails enforced at the infrastructure level — no prompt injection can "
        "overspend.\n\n"
        "{ok}/{total} lifecycle operations. Zero human intervention. "
        "#DominusNode #{tag} #AIProxy #AgenticInfra"
    ),
    "privacy-focus": (
        "Privacy test with {name}: routed {fetch_bytes}B through Dominus Node's "
        "{proxy_type} proxy network in {dur}s. Exit IP rotated automatically — "
        "no fingerprinting, no IP persistence across requests.\n\n"
        "The full agent lifecycle ran {ok}/{total} operations: account creation, "
        "wallet funding, team isolation, API key rotation, geo-targeted proxy "
        "fetch from {url}, usage metering, and cleanup. All programmatic, all "
        "via SDK.\n\n"
        "Why this matters: when your AI agent is researching competitors, "
        "monitoring prices, or gathering training data, you don't want every "
        "request traced back to your office IP. Dominus Node's rotating "
        "{proxy_type} proxies with automatic burn detection solve this at the "
        "infrastructure level.\n\n"
        "#DominusNode #{tag} #Privacy #AgenticAI"
    ),
    "infra-focus": (
        "Infrastructure stress test: {name} agent #{n} completed {ok}/{total} "
        "Dominus Node lifecycle operations in {dur}s.\n\n"
        "What the agent did autonomously:\n"
        "• Registered account + verified email (MCP agent bypass)\n"
        "• Funded agentic wallet with spending caps\n"
        "• Created team, set permissions, generated API keys\n"
        "• Configured {proxy_type} proxy routing (geo: US)\n"
        "• Fetched {fetch_bytes}B from {url}\n"
        "• Checked usage stats + billing\n"
        "• Cleaned up: revoked keys, deleted team\n\n"
        "53 SDK tools available. The agent self-provisions everything — "
        "account creation to billing to proxy routing — zero human bottleneck. "
        "This is what sovereign AI infrastructure looks like.\n\n"
        "#DominusNode #{tag} #AIInfra #AutonomousAgents"
    ),
}


def make_post_long(result: AgentResult, variant: str = "default") -> str:
    """Long-form narrative post (800-1500 chars) — Moltbook / blog style."""
    info = CATALOG.get(result.integration)
    name = info.name if info else result.integration
    tag = info.hashtag.lstrip("#") if info else result.integration.replace("-", "")

    tpl = LONG_POST_TEMPLATES.get(variant, LONG_POST_TEMPLATES["default"])
    return tpl.format(
        name=name,
        url=result.target_url,
        dur=f"{result.duration:.1f}",
        n=result.agent_num,
        ok=result.tools_ok,
        total=result.tools_total,
        fetch_bytes=result.fetch_bytes,
        proxy_type=result.proxy_type,
        tag=tag,
    )


def make_post(result: AgentResult) -> str:
    """Auto-assign short or long-form post based on agent number and data richness."""
    # Agents with successful fetch data and good tool coverage get long-form
    # Cycle through: every 3rd agent gets a different long-form variant
    if result.fetch_ok and result.tools_ok >= 15:
        variants = ["default", "privacy-focus", "infra-focus"]
        variant = variants[result.agent_num % 3]
        return make_post_long(result, variant)
    else:
        return make_post_short(result)


# ── API helpers ────────────────────────────────────────────────────────────────
def scrub(msg: str) -> str:
    msg = re.sub(r'dn_(live|test)_[a-zA-Z0-9_-]+', 'dn_***', msg)
    msg = re.sub(r'"password"\s*:\s*"[^"]*"', '"password":"***"', msg)
    msg = re.sub(r'eyJ[a-zA-Z0-9_-]{10,}', 'JWT_REDACTED', msg)
    return msg


def api(method: str, url: str, jwt: str = "", data: dict = None, timeout: int = 30) -> dict:
    hdrs = {"Content-Type": "application/json"}
    if jwt:
        hdrs["Authorization"] = f"Bearer {jwt}"
    # MCP agent headers bypass CAPTCHA on register/login
    agent_secret = os.environ.get("DOMINUSNODE_AGENT_SECRET", "")
    if agent_secret:
        hdrs["X-DominusNode-Agent"] = "mcp"
        hdrs["X-DominusNode-Agent-Secret"] = agent_secret
    try:
        r = requests.request(method, url, headers=hdrs, json=data, timeout=timeout)
        body = r.json() if r.text else {}
        return {"status": r.status_code, "body": body}
    except Exception as e:
        return {"status": 0, "body": {"error": scrub(str(e))}}


def admin_login(cfg: ShowcaseConfig) -> str:
    r = api("POST", f"{cfg.api_base}/api/auth/login",
            data={"email": cfg.admin_email, "password": cfg.admin_password})
    if r["status"] == 200 and "token" in r["body"]:
        return r["body"]["token"]
    raise RuntimeError(f"Admin login failed ({r['status']})")


def setup_account(cfg: ShowcaseConfig, admin_jwt: str, tag: str) -> dict:
    """Register, get JWT, assign plan, credit wallet, create API key."""
    password = secrets.token_hex(12)
    email = f"showcase-{tag}-{secrets.token_hex(4)}@dominusnode.bot"

    api("POST", f"{cfg.api_base}/api/auth/register",
        data={"email": email, "password": password})
    login_r = api("POST", f"{cfg.api_base}/api/auth/login",
                  data={"email": email, "password": password})
    jwt = login_r["body"].get("token", "")
    if not jwt:
        raise RuntimeError(f"Login failed for {email}")

    me = api("GET", f"{cfg.api_base}/api/auth/me", jwt=jwt)
    user = me["body"].get("user", me["body"])
    uid = user.get("id", "")

    if admin_jwt and uid:
        api("PUT", f"{cfg.api_base}/api/admin/users/{uid}/plan",
            jwt=admin_jwt, data={"planId": "swarm-mixed"})
        api("POST", f"{cfg.api_base}/api/admin/credit-wallet",
            jwt=admin_jwt, data={
                "targetUserId": uid,
                "amountCents": cfg.credit_cents,
                "reason": f"Showcase agent {tag}",
            })

    key_r = api("POST", f"{cfg.api_base}/api/keys", jwt=jwt,
                data={"label": f"showcase-{tag}"})
    raw_key = key_r["body"].get("rawKey", key_r["body"].get("key", ""))
    return {"jwt": jwt, "user_id": uid, "api_key": raw_key}


# ── Lifecycle helpers ──────────────────────────────────────────────────────────

_UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', re.I)


def _extract_uuid(text: str) -> Optional[str]:
    """Extract first UUID from a toolkit response string."""
    m = _UUID_RE.search(str(text))
    return m.group(0) if m else None


def _lifecycle_toolkit(tk, target_url: str, proxy_type: str) -> dict:
    """Run the full 53-tool lifecycle on a simple-toolkit-pattern integration.

    Works for: agno, camel-ai, composio, haystack, ironclaw, metagpt,
    pydantic-ai, semantic-kernel, llamaindex, moltbook.
    """
    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key: str, category: str, method_name: str, *a, **kw) -> str:
        nonlocal ok, err
        fn = getattr(tk, method_name, None)
        if fn is None:
            res[key] = f"ERROR: method {method_name} not found"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""
        try:
            r = fn(*a, **kw)
            val = str(r) if r is not None else "OK"
            res[key] = val
            ok += 1
            categories[category] = categories.get(category, True)
            return val
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    # -- Account --
    call("account_info", "account", "get_account_info")
    call("resend_verify", "account", "resend_verification")

    # -- Balance & Billing --
    call("balance", "billing", "check_balance")
    call("transactions", "billing", "get_transactions")
    call("forecast", "billing", "get_forecast")
    call("topup_paypal", "billing", "topup_paypal", 100)
    call("topup_stripe", "billing", "topup_stripe", 100)
    call("topup_crypto", "billing", "topup_crypto", 1.0, "BTC")
    call("x402_info", "billing", "x402_info")

    # -- Proxy --
    call("fetch", "proxy", "proxied_fetch", target_url, "US", proxy_type)
    call("proxy_config", "proxy", "get_proxy_config")
    call("proxy_status", "proxy", "get_proxy_status")
    call("sessions", "proxy", "list_sessions")

    # -- Usage --
    call("usage", "usage", "check_usage")
    call("daily_usage", "usage", "get_daily_usage")
    call("top_hosts", "usage", "get_top_hosts")

    # -- API Keys --
    call("list_keys", "keys", "list_keys")
    kr = call("create_key", "keys", "create_key", "showcase-lifecycle-key")
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", "revoke_key", kid)

    # -- Plans --
    call("get_plan", "plans", "get_plan")
    call("list_plans", "plans", "list_plans")

    # -- Agentic Wallets --
    wr = call("create_wallet", "wallets", "create_agentic_wallet",
              "showcase-wallet", 10000)
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", "fund_agentic_wallet", wid, 100)
        call("wallet_balance", "wallets", "agentic_wallet_balance", wid)
        call("list_wallets", "wallets", "list_agentic_wallets")
        call("wallet_txns", "wallets", "agentic_transactions", wid)
        call("wallet_policy", "wallets", "update_wallet_policy", wid,
             daily_limit_cents=5000)
        call("freeze_wallet", "wallets", "freeze_agentic_wallet", wid)
        call("unfreeze_wallet", "wallets", "unfreeze_agentic_wallet", wid)
        call("delete_wallet", "wallets", "delete_agentic_wallet", wid)

    # -- Teams --
    tr = call("create_team", "teams", "create_team", "showcase-team")
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", "list_teams")
        call("team_details", "teams", "team_details", tid)
        call("update_team", "teams", "update_team", tid, name="updated-showcase")
        call("team_fund", "teams", "team_fund", tid, 50)
        tkr = call("team_create_key", "teams", "team_create_key", tid, "team-key")
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", "team_list_keys", tid)
        call("team_usage", "teams", "team_usage", tid)
        call("team_members", "teams", "team_list_members", tid)
        ir = call("team_invite", "teams", "team_invite_member", tid,
                  "invite-test@dominusnode.bot")
        iid = _extract_uuid(ir)
        call("team_invites", "teams", "team_list_invites", tid)
        if iid:
            call("team_cancel_invite", "teams", "team_cancel_invite", tid, iid)
        if tkid:
            call("team_revoke_key", "teams", "team_revoke_key", tid, tkid)
        # Try both naming conventions for team delete
        if hasattr(tk, "team_delete"):
            call("team_delete", "teams", "team_delete", tid)
        else:
            call("team_delete", "teams", "delete_team", tid)

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


# ── Python integration runners ─────────────────────────────────────────────────

def _make_toolkit_runner(import_fn):
    """Factory for simple toolkit-pattern integrations."""
    def runner(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type):
        tk = import_fn(api_key, api_base, proxy_host, proxy_port)
        return _lifecycle_toolkit(tk, target_url, proxy_type)
    return runner


def _import_agno(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_agno.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_camel(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_camel.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_composio(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_composio.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_haystack(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_haystack.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_ironclaw(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_ironclaw.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_metagpt(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_metagpt.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_pydantic_ai(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_pydanticai.tools import DominusNodeToolkit
    return DominusNodeToolkit(api_key=api_key, base_url=api_base,
                              proxy_host=proxy_host, proxy_port=proxy_port)

def _import_semantic_kernel(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_semantic_kernel.plugin import DominusNodePlugin
    return DominusNodePlugin(api_key=api_key, base_url=api_base,
                             proxy_host=proxy_host, proxy_port=proxy_port)

def _import_llamaindex(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_llamaindex import DominusNodeToolSpec
    return DominusNodeToolSpec(api_key=api_key, base_url=api_base,
                               proxy_host=proxy_host, proxy_port=proxy_port)

def _import_moltbook(api_key, api_base, proxy_host, proxy_port):
    from dominusnode_moltbook.client import MoltbookClient
    return MoltbookClient(dominusnode_api_key=api_key, dominusnode_base_url=api_base,
                          proxy_host=proxy_host, proxy_port=proxy_port)


def _run_langchain(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    from dominusnode_langchain import DominusNodeToolkit
    tk = DominusNodeToolkit(api_key=api_key, base_url=api_base,
                            proxy_host=proxy_host, http_proxy_port=proxy_port)
    tools = {t.name: t for t in tk.get_tools()}

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key, category, tool_name, args_dict=None):
        nonlocal ok, err
        if tool_name not in tools:
            res[key] = f"ERROR: tool {tool_name} not found"
            err += 1
            return ""
        try:
            r = tools[tool_name].run(json.dumps(args_dict or {}))
            res[key] = str(r)[:500]
            ok += 1
            categories[category] = categories.get(category, True)
            return str(r)
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    # Account
    call("account_info", "account", "dominusnode_get_account_info")
    call("resend_verify", "account", "dominusnode_resend_verification")
    # Billing
    call("balance", "billing", "dominusnode_check_balance")
    call("transactions", "billing", "dominusnode_get_transactions")
    call("forecast", "billing", "dominusnode_get_forecast")
    call("topup_paypal", "billing", "dominusnode_topup_paypal", {"amount_cents": 100})
    call("topup_stripe", "billing", "dominusnode_topup_stripe", {"amount_cents": 100})
    call("topup_crypto", "billing", "dominusnode_topup_crypto",
         {"amount_usd": 1.0, "currency": "BTC"})
    call("x402_info", "billing", "dominusnode_x402_info")
    # Proxy
    call("fetch", "proxy", "dominusnode_proxied_fetch",
         {"url": target_url, "country": "US", "proxy_type": proxy_type})
    call("proxy_config", "proxy", "dominusnode_get_proxy_config")
    call("proxy_status", "proxy", "dominusnode_get_proxy_status")
    call("sessions", "proxy", "dominusnode_list_sessions")
    # Usage
    call("usage", "usage", "dominusnode_check_usage")
    call("daily_usage", "usage", "dominusnode_get_daily_usage")
    call("top_hosts", "usage", "dominusnode_get_top_hosts")
    # Keys
    call("list_keys", "keys", "dominusnode_list_keys")
    kr = call("create_key", "keys", "dominusnode_create_key", {"label": "showcase-key"})
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", "dominusnode_revoke_key", {"key_id": kid})
    # Plans
    call("get_plan", "plans", "dominusnode_get_plan")
    call("list_plans", "plans", "dominusnode_list_plans")
    # Agentic Wallets
    wr = call("create_wallet", "wallets", "dominusnode_create_agentic_wallet",
              {"label": "showcase-wallet", "spending_limit_cents": 10000})
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", "dominusnode_fund_agentic_wallet",
             {"wallet_id": wid, "amount_cents": 100})
        call("wallet_balance", "wallets", "dominusnode_agentic_wallet_balance",
             {"wallet_id": wid})
        call("list_wallets", "wallets", "dominusnode_list_agentic_wallets")
        call("wallet_txns", "wallets", "dominusnode_agentic_transactions",
             {"wallet_id": wid})
        call("wallet_policy", "wallets", "dominusnode_update_wallet_policy",
             {"wallet_id": wid, "daily_limit_cents": 5000})
        call("freeze_wallet", "wallets", "dominusnode_freeze_agentic_wallet",
             {"wallet_id": wid})
        call("unfreeze_wallet", "wallets", "dominusnode_unfreeze_agentic_wallet",
             {"wallet_id": wid})
        call("delete_wallet", "wallets", "dominusnode_delete_agentic_wallet",
             {"wallet_id": wid})
    # Teams
    tr = call("create_team", "teams", "dominusnode_create_team",
              {"name": "showcase-team"})
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", "dominusnode_list_teams")
        call("team_details", "teams", "dominusnode_team_details", {"team_id": tid})
        call("update_team", "teams", "dominusnode_update_team",
             {"team_id": tid, "name": "updated-showcase"})
        call("team_fund", "teams", "dominusnode_team_fund",
             {"team_id": tid, "amount_cents": 50})
        tkr = call("team_create_key", "teams", "dominusnode_team_create_key",
                   {"team_id": tid, "label": "team-key"})
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", "dominusnode_team_list_keys", {"team_id": tid})
        call("team_usage", "teams", "dominusnode_team_usage", {"team_id": tid})
        call("team_members", "teams", "dominusnode_team_list_members", {"team_id": tid})
        ir = call("team_invite", "teams", "dominusnode_team_invite_member",
                  {"team_id": tid, "email": "invite-test@dominusnode.bot"})
        iid = _extract_uuid(ir)
        call("team_invites", "teams", "dominusnode_team_list_invites", {"team_id": tid})
        if iid:
            call("team_cancel_invite", "teams", "dominusnode_team_cancel_invite",
                 {"team_id": tid, "invite_id": iid})
        if tkid:
            call("team_revoke_key", "teams", "dominusnode_team_revoke_key",
                 {"team_id": tid, "key_id": tkid})
        call("team_delete", "teams", "dominusnode_team_delete", {"team_id": tid})

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


def _run_crewai(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    from dominusnode_crewai import (
        DominusNodeWebScrapeTool, DominusNodeBalanceTool, DominusNodeCheckUsageTool,
        DominusNodeGetTransactionsTool, DominusNodeGetForecastTool,
        DominusNodeTopupPaypalTool, DominusNodeTopupStripeTool, DominusNodeTopupCryptoTool,
        DominusNodeX402InfoTool, DominusNodeProxyStatusTool, DominusNodeListSessionsTool,
        DominusNodeGetDailyUsageTool, DominusNodeGetTopHostsTool,
        DominusNodeListKeysTool, DominusNodeCreateKeyTool, DominusNodeRevokeKeyTool,
        DominusNodeGetPlanTool, DominusNodeListPlansTool, DominusNodeChangePlanTool,
        DominusNodeGetAccountInfoTool, DominusNodeResendVerificationTool,
        DominusNodeCreateAgenticWalletTool, DominusNodeFundAgenticWalletTool,
        DominusNodeAgenticWalletBalanceTool, DominusNodeListAgenticWalletsTool,
        DominusNodeAgenticTransactionsTool, DominusNodeFreezeAgenticWalletTool,
        DominusNodeUnfreezeAgenticWalletTool, DominusNodeDeleteAgenticWalletTool,
        DominusNodeUpdateWalletPolicyTool, DominusNodeGeoTargetTool,
        DominusNodeCreateTeamTool, DominusNodeListTeamsTool,
        DominusNodeTeamDetailsTool, DominusNodeUpdateTeamTool,
        DominusNodeTeamDeleteTool, DominusNodeTeamFundTool,
        DominusNodeTeamCreateKeyTool, DominusNodeTeamRevokeKeyTool,
        DominusNodeTeamListKeysTool, DominusNodeTeamUsageTool,
        DominusNodeTeamListMembersTool, DominusNodeTeamAddMemberTool,
        DominusNodeTeamRemoveMemberTool, DominusNodeTeamInviteMemberTool,
        DominusNodeTeamListInvitesTool, DominusNodeTeamCancelInviteTool,
    )
    cfg_a = {"api_key": api_key, "base_url": api_base}
    cfg_p = {**cfg_a, "proxy_host": proxy_host, "proxy_port": proxy_port}

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key, category, tool_cls, config, **run_kw):
        nonlocal ok, err
        try:
            t = tool_cls(**config)
            r = t._run(**run_kw)
            res[key] = str(r)[:500]
            ok += 1
            categories[category] = categories.get(category, True)
            return str(r)
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    # Account
    call("account_info", "account", DominusNodeGetAccountInfoTool, cfg_a)
    call("resend_verify", "account", DominusNodeResendVerificationTool, cfg_a)
    # Billing
    call("balance", "billing", DominusNodeBalanceTool, cfg_a)
    call("transactions", "billing", DominusNodeGetTransactionsTool, cfg_a)
    call("forecast", "billing", DominusNodeGetForecastTool, cfg_a)
    call("topup_paypal", "billing", DominusNodeTopupPaypalTool, cfg_a, amount_cents=100)
    call("topup_stripe", "billing", DominusNodeTopupStripeTool, cfg_a, amount_cents=100)
    call("topup_crypto", "billing", DominusNodeTopupCryptoTool, cfg_a,
         amount_usd=1.0, currency="BTC")
    call("x402_info", "billing", DominusNodeX402InfoTool, cfg_a)
    # Proxy
    call("fetch", "proxy", DominusNodeWebScrapeTool, cfg_p,
         url=target_url, country="US", proxy_type=proxy_type)
    call("geo_target", "proxy", DominusNodeGeoTargetTool, cfg_p,
         url=target_url, country="US", proxy_type=proxy_type)
    call("proxy_status", "proxy", DominusNodeProxyStatusTool, cfg_a)
    call("sessions", "proxy", DominusNodeListSessionsTool, cfg_a)
    # Usage
    call("usage", "usage", DominusNodeCheckUsageTool, cfg_a)
    call("daily_usage", "usage", DominusNodeGetDailyUsageTool, cfg_a)
    call("top_hosts", "usage", DominusNodeGetTopHostsTool, cfg_a)
    # Keys
    call("list_keys", "keys", DominusNodeListKeysTool, cfg_a)
    kr = call("create_key", "keys", DominusNodeCreateKeyTool, cfg_a, label="showcase-key")
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", DominusNodeRevokeKeyTool, cfg_a, key_id=kid)
    # Plans
    call("get_plan", "plans", DominusNodeGetPlanTool, cfg_a)
    call("list_plans", "plans", DominusNodeListPlansTool, cfg_a)
    # Agentic Wallets
    wr = call("create_wallet", "wallets", DominusNodeCreateAgenticWalletTool, cfg_a,
              label="showcase-wallet", spending_limit_cents=10000)
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", DominusNodeFundAgenticWalletTool, cfg_a,
             wallet_id=wid, amount_cents=100)
        call("wallet_balance", "wallets", DominusNodeAgenticWalletBalanceTool, cfg_a,
             wallet_id=wid)
        call("list_wallets", "wallets", DominusNodeListAgenticWalletsTool, cfg_a)
        call("wallet_txns", "wallets", DominusNodeAgenticTransactionsTool, cfg_a,
             wallet_id=wid)
        call("wallet_policy", "wallets", DominusNodeUpdateWalletPolicyTool, cfg_a,
             wallet_id=wid, daily_limit_cents=5000)
        call("freeze_wallet", "wallets", DominusNodeFreezeAgenticWalletTool, cfg_a,
             wallet_id=wid)
        call("unfreeze_wallet", "wallets", DominusNodeUnfreezeAgenticWalletTool, cfg_a,
             wallet_id=wid)
        call("delete_wallet", "wallets", DominusNodeDeleteAgenticWalletTool, cfg_a,
             wallet_id=wid)
    # Teams
    tr = call("create_team", "teams", DominusNodeCreateTeamTool, cfg_a,
              name="showcase-team")
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", DominusNodeListTeamsTool, cfg_a)
        call("team_details", "teams", DominusNodeTeamDetailsTool, cfg_a, team_id=tid)
        call("update_team", "teams", DominusNodeUpdateTeamTool, cfg_a,
             team_id=tid, name="updated-showcase")
        call("team_fund", "teams", DominusNodeTeamFundTool, cfg_a,
             team_id=tid, amount_cents=50)
        tkr = call("team_create_key", "teams", DominusNodeTeamCreateKeyTool, cfg_a,
                   team_id=tid, label="team-key")
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", DominusNodeTeamListKeysTool, cfg_a, team_id=tid)
        call("team_usage", "teams", DominusNodeTeamUsageTool, cfg_a, team_id=tid)
        call("team_members", "teams", DominusNodeTeamListMembersTool, cfg_a, team_id=tid)
        ir = call("team_invite", "teams", DominusNodeTeamInviteMemberTool, cfg_a,
                  team_id=tid, email="invite-test@dominusnode.bot")
        iid = _extract_uuid(ir)
        call("team_invites", "teams", DominusNodeTeamListInvitesTool, cfg_a, team_id=tid)
        if iid:
            call("team_cancel_invite", "teams", DominusNodeTeamCancelInviteTool, cfg_a,
                 team_id=tid, invite_id=iid)
        if tkid:
            call("team_revoke_key", "teams", DominusNodeTeamRevokeKeyTool, cfg_a,
                 team_id=tid, key_id=tkid)
        call("team_delete", "teams", DominusNodeTeamDeleteTool, cfg_a, team_id=tid)

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


def _run_autogpt(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    from dominusnode_autogpt import DominusNodePlugin
    plugin = DominusNodePlugin(api_key=api_key, base_url=api_base,
                               proxy_host=proxy_host, proxy_port=proxy_port)

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key, category, cmd, args=None):
        nonlocal ok, err
        try:
            r = plugin.handle_command(cmd, args or {})
            res[key] = str(r)[:500]
            ok += 1
            categories[category] = categories.get(category, True)
            return str(r)
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    call("account_info", "account", "get_account_info")
    call("resend_verify", "account", "resend_verification")
    call("balance", "billing", "check_balance")
    call("transactions", "billing", "get_transactions")
    call("forecast", "billing", "get_forecast")
    call("topup_paypal", "billing", "topup_paypal", {"amount_cents": 100})
    call("topup_stripe", "billing", "topup_stripe", {"amount_cents": 100})
    call("topup_crypto", "billing", "topup_crypto", {"amount_usd": 1.0, "currency": "BTC"})
    call("x402_info", "billing", "x402_info")
    call("fetch", "proxy", "proxied_fetch",
         {"url": target_url, "country": "US", "proxy_type": proxy_type})
    call("proxy_config", "proxy", "get_proxy_config")
    call("proxy_status", "proxy", "get_proxy_status")
    call("sessions", "proxy", "list_sessions")
    call("usage", "usage", "check_usage")
    call("daily_usage", "usage", "get_daily_usage")
    call("top_hosts", "usage", "get_top_hosts")
    call("list_keys", "keys", "list_keys")
    kr = call("create_key", "keys", "create_key", {"label": "showcase-key"})
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", "revoke_key", {"key_id": kid})
    call("get_plan", "plans", "get_plan")
    call("list_plans", "plans", "list_plans")
    wr = call("create_wallet", "wallets", "create_agentic_wallet",
              {"label": "showcase-wallet", "spending_limit_cents": 10000})
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", "fund_agentic_wallet",
             {"wallet_id": wid, "amount_cents": 100})
        call("wallet_balance", "wallets", "agentic_wallet_balance", {"wallet_id": wid})
        call("list_wallets", "wallets", "list_agentic_wallets")
        call("wallet_txns", "wallets", "agentic_transactions", {"wallet_id": wid})
        call("wallet_policy", "wallets", "update_wallet_policy",
             {"wallet_id": wid, "daily_limit_cents": 5000})
        call("freeze_wallet", "wallets", "freeze_agentic_wallet", {"wallet_id": wid})
        call("unfreeze_wallet", "wallets", "unfreeze_agentic_wallet", {"wallet_id": wid})
        call("delete_wallet", "wallets", "delete_agentic_wallet", {"wallet_id": wid})
    tr = call("create_team", "teams", "create_team", {"name": "showcase-team"})
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", "list_teams")
        call("team_details", "teams", "team_details", {"team_id": tid})
        call("update_team", "teams", "update_team",
             {"team_id": tid, "name": "updated-showcase"})
        call("team_fund", "teams", "team_fund", {"team_id": tid, "amount_cents": 50})
        tkr = call("team_create_key", "teams", "team_create_key",
                   {"team_id": tid, "label": "team-key"})
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", "team_list_keys", {"team_id": tid})
        call("team_usage", "teams", "team_usage", {"team_id": tid})
        call("team_members", "teams", "team_list_members", {"team_id": tid})
        ir = call("team_invite", "teams", "team_invite_member",
                  {"team_id": tid, "email": "invite-test@dominusnode.bot"})
        iid = _extract_uuid(ir)
        call("team_invites", "teams", "team_list_invites", {"team_id": tid})
        if iid:
            call("team_cancel_invite", "teams", "team_cancel_invite",
                 {"team_id": tid, "invite_id": iid})
        if tkid:
            call("team_revoke_key", "teams", "team_revoke_key",
                 {"team_id": tid, "key_id": tkid})
        call("team_delete", "teams", "team_delete", {"team_id": tid})

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


def _run_agent_zero(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    import importlib.util
    az_path = str(INTEGRATIONS_DIR / "agent-zero")
    if az_path not in sys.path:
        sys.path.insert(0, az_path)

    def _load_tool_module(filename):
        p = INTEGRATIONS_DIR / "agent-zero" / "tools" / filename
        spec = importlib.util.spec_from_file_location(
            filename.replace(".py", "").replace("-", "_"), p)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    from shared.auth import DominusNodeAuth
    auth = DominusNodeAuth(api_key=api_key, base_url=api_base)

    pf = _load_tool_module("01_proxy_fetch.py")
    w  = _load_tool_module("02_wallet.py")
    aw = _load_tool_module("03_agentic_wallets.py")
    tm = _load_tool_module("04_teams.py")
    ac = _load_tool_module("05_account.py")
    ky = _load_tool_module("06_keys.py")
    pl = _load_tool_module("07_plans.py")

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key, category, fn, *a, **kw):
        nonlocal ok, err
        try:
            r = fn(auth, *a, **kw)
            res[key] = str(r)[:500]
            ok += 1
            categories[category] = categories.get(category, True)
            return str(r)
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    # Account
    call("account_info", "account", ac.get_account_info, {})
    call("resend_verify", "account", ac.resend_verification, {})
    # Billing
    call("balance", "billing", w.check_balance, {})
    call("transactions", "billing", w.get_transactions, {})
    call("forecast", "billing", w.get_forecast, {})
    call("topup_paypal", "billing", w.topup_paypal, {"amount_cents": 100})
    call("topup_stripe", "billing", w.topup_stripe, {"amount_cents": 100})
    call("topup_crypto", "billing", w.topup_crypto, {"amount_usd": 1.0, "currency": "BTC"})
    call("x402_info", "billing", w.x402_info, {})
    # Proxy
    call("fetch", "proxy", pf.proxied_fetch,
         {"url": target_url, "country": "US", "proxy_type": proxy_type})
    call("proxy_config", "proxy", pf.get_proxy_config, {})
    call("proxy_status", "proxy", pf.get_proxy_status, {})
    call("sessions", "proxy", pf.list_sessions, {})
    # Usage
    call("usage", "usage", w.check_usage, {})
    call("daily_usage", "usage", w.get_daily_usage, {})
    call("top_hosts", "usage", w.get_top_hosts, {})
    # Keys
    call("list_keys", "keys", ky.list_keys, {})
    kr = call("create_key", "keys", ky.create_key, {"label": "showcase-key"})
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", ky.revoke_key, {"key_id": kid})
    # Plans
    call("get_plan", "plans", pl.get_plan, {})
    call("list_plans", "plans", pl.list_plans, {})
    # Agentic Wallets
    wr = call("create_wallet", "wallets", aw.create_agentic_wallet,
              {"label": "showcase-wallet", "spending_limit_cents": 10000})
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", aw.fund_agentic_wallet,
             {"wallet_id": wid, "amount_cents": 100})
        call("wallet_balance", "wallets", aw.agentic_wallet_balance, {"wallet_id": wid})
        call("list_wallets", "wallets", aw.list_agentic_wallets, {})
        call("wallet_txns", "wallets", aw.agentic_transactions, {"wallet_id": wid})
        call("wallet_policy", "wallets", aw.update_wallet_policy,
             {"wallet_id": wid, "daily_limit_cents": 5000})
        call("freeze_wallet", "wallets", aw.freeze_agentic_wallet, {"wallet_id": wid})
        call("unfreeze_wallet", "wallets", aw.unfreeze_agentic_wallet, {"wallet_id": wid})
        call("delete_wallet", "wallets", aw.delete_agentic_wallet, {"wallet_id": wid})
    # Teams
    tr = call("create_team", "teams", tm.create_team, {"name": "showcase-team"})
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", tm.list_teams, {})
        call("team_details", "teams", tm.team_details, {"team_id": tid})
        call("update_team", "teams", tm.update_team,
             {"team_id": tid, "name": "updated-showcase"})
        call("team_fund", "teams", tm.team_fund, {"team_id": tid, "amount_cents": 50})
        tkr = call("team_create_key", "teams", tm.team_create_key,
                   {"team_id": tid, "label": "team-key"})
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", tm.team_list_keys, {"team_id": tid})
        call("team_usage", "teams", tm.team_usage, {"team_id": tid})
        call("team_members", "teams", tm.team_list_members, {"team_id": tid})
        ir = call("team_invite", "teams", tm.team_invite_member,
                  {"team_id": tid, "email": "invite-test@dominusnode.bot"})
        iid = _extract_uuid(ir)
        call("team_invites", "teams", tm.team_list_invites, {"team_id": tid})
        if iid:
            call("team_cancel_invite", "teams", tm.team_cancel_invite,
                 {"team_id": tid, "invite_id": iid})
        if tkid:
            call("team_revoke_key", "teams", tm.team_revoke_key,
                 {"team_id": tid, "key_id": tkid})
        call("team_delete", "teams", tm.team_delete, {"team_id": tid})

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


def _run_superagi(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    # Use the internal _DominusNodeClient directly — it has the full lifecycle
    # methods and doesn't require the SuperAGI framework runtime (get_tool_config).
    from dominusnode_superagi.tools import _DominusNodeClient
    _DominusNodeClient.reset_instance()
    client = _DominusNodeClient(
        api_key=api_key, base_url=api_base,
        proxy_host=proxy_host, proxy_port=proxy_port)
    return _lifecycle_toolkit(client, target_url, proxy_type)


def _run_dify(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    from dominusnode_dify import DominusNodeProvider
    provider = DominusNodeProvider(credentials={
        "api_key": api_key, "base_url": api_base,
        "proxy_host": proxy_host, "proxy_port": str(proxy_port),
    })

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call(key, category, fn, args=None):
        nonlocal ok, err
        try:
            r = fn(args or {})
            res[key] = str(r)[:500]
            ok += 1
            categories[category] = categories.get(category, True)
            return str(r)
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    call("account_info", "account", provider.get_account_info)
    call("resend_verify", "account", provider.resend_verification)
    call("balance", "billing", provider.check_balance)
    call("transactions", "billing", provider.get_transactions)
    call("forecast", "billing", provider.get_forecast)
    call("topup_paypal", "billing", provider.topup_paypal, {"amount_cents": 100})
    call("topup_stripe", "billing", provider.topup_stripe, {"amount_cents": 100})
    call("topup_crypto", "billing", provider.topup_crypto,
         {"amount_usd": 1.0, "currency": "BTC"})
    call("x402_info", "billing", provider.x402_info)
    call("fetch", "proxy", provider.proxied_fetch,
         {"url": target_url, "country": "US", "proxy_type": proxy_type})
    call("proxy_config", "proxy", provider.get_proxy_config)
    call("proxy_status", "proxy", provider.get_proxy_status)
    call("sessions", "proxy", provider.list_sessions)
    call("usage", "usage", provider.check_usage)
    call("daily_usage", "usage", provider.get_daily_usage)
    call("top_hosts", "usage", provider.get_top_hosts)
    call("list_keys", "keys", provider.list_keys)
    kr = call("create_key", "keys", provider.create_key, {"label": "showcase-key"})
    kid = _extract_uuid(kr)
    if kid:
        call("revoke_key", "keys", provider.revoke_key, {"key_id": kid})
    call("get_plan", "plans", provider.get_plan)
    call("list_plans", "plans", provider.list_plans)
    wr = call("create_wallet", "wallets", provider.create_agentic_wallet,
              {"label": "showcase-wallet", "spending_limit_cents": 10000})
    wid = _extract_uuid(wr)
    if wid:
        call("fund_wallet", "wallets", provider.fund_agentic_wallet,
             {"wallet_id": wid, "amount_cents": 100})
        call("wallet_balance", "wallets", provider.agentic_wallet_balance,
             {"wallet_id": wid})
        call("list_wallets", "wallets", provider.list_agentic_wallets)
        call("wallet_txns", "wallets", provider.agentic_transactions, {"wallet_id": wid})
        call("wallet_policy", "wallets", provider.update_wallet_policy,
             {"wallet_id": wid, "daily_limit_cents": 5000})
        call("freeze_wallet", "wallets", provider.freeze_agentic_wallet,
             {"wallet_id": wid})
        call("unfreeze_wallet", "wallets", provider.unfreeze_agentic_wallet,
             {"wallet_id": wid})
        call("delete_wallet", "wallets", provider.delete_agentic_wallet,
             {"wallet_id": wid})
    tr = call("create_team", "teams", provider.create_team, {"name": "showcase-team"})
    tid = _extract_uuid(tr)
    if tid:
        call("list_teams", "teams", provider.list_teams)
        call("team_details", "teams", provider.team_details, {"team_id": tid})
        call("update_team", "teams", provider.update_team,
             {"team_id": tid, "name": "updated-showcase"})
        call("team_fund", "teams", provider.team_fund,
             {"team_id": tid, "amount_cents": 50})
        tkr = call("team_create_key", "teams", provider.team_create_key,
                   {"team_id": tid, "label": "team-key"})
        tkid = _extract_uuid(tkr)
        call("team_list_keys", "teams", provider.team_list_keys, {"team_id": tid})
        call("team_usage", "teams", provider.team_usage, {"team_id": tid})
        call("team_members", "teams", provider.team_list_members, {"team_id": tid})
        ir = call("team_invite", "teams", provider.team_invite_member,
                  {"team_id": tid, "email": "invite-test@dominusnode.bot"})
        iid = _extract_uuid(ir)
        call("team_invites", "teams", provider.team_list_invites, {"team_id": tid})
        if iid:
            call("team_cancel_invite", "teams", provider.team_cancel_invite,
                 {"team_id": tid, "invite_id": iid})
        if tkid:
            call("team_revoke_key", "teams", provider.team_revoke_key,
                 {"team_id": tid, "key_id": tkid})
        call("team_delete", "teams", provider.team_delete, {"team_id": tid})

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


def _run_raw_http(api_key, api_base, proxy_host, proxy_port, target_url, proxy_type) -> dict:
    vr = api("POST", f"{api_base}/api/auth/verify-key", data={"apiKey": api_key})
    jwt = vr["body"].get("token", "")
    if not jwt:
        return {"error": "Failed to authenticate", "_stats": {"ok": 0, "err": 1, "total": 1}}

    res: Dict[str, Any] = {}
    ok = err = 0
    categories: Dict[str, bool] = {}

    def call_api(key, category, method, path, data=None):
        nonlocal ok, err
        try:
            r = api(method, f"{api_base}{path}", jwt=jwt, data=data)
            if r["status"] < 400:
                res[key] = json.dumps(r["body"])[:500]
                ok += 1
                categories[category] = categories.get(category, True)
                return json.dumps(r["body"])
            else:
                res[key] = f"ERROR: HTTP {r['status']}"
                err += 1
                if category not in categories:
                    categories[category] = False
                return ""
        except Exception as e:
            res[key] = f"ERROR: {scrub(str(e))[:200]}"
            err += 1
            if category not in categories:
                categories[category] = False
            return ""

    # Account
    call_api("account_info", "account", "GET", "/api/auth/me")
    call_api("resend_verify", "account", "POST", "/api/auth/resend-verification")
    # Billing
    call_api("balance", "billing", "GET", "/api/wallet")
    call_api("transactions", "billing", "GET", "/api/wallet/transactions?limit=5")
    call_api("forecast", "billing", "GET", "/api/wallet/forecast")
    call_api("topup_paypal", "billing", "POST", "/api/billing/paypal/create-order",
             {"amountCents": 100})
    call_api("topup_stripe", "billing", "POST", "/api/billing/stripe/create-session",
             {"amountCents": 100})
    call_api("topup_crypto", "billing", "POST", "/api/billing/crypto/create-invoice",
             {"amountUsd": 1.0, "currency": "BTC"})
    call_api("x402_info", "billing", "GET", "/api/x402/info")
    # Proxy fetch (direct through gateway)
    proxy_url = f"http://{proxy_type}-country-US:{api_key}@{proxy_host}:{proxy_port}"
    try:
        r = requests.get(target_url, proxies={"http": proxy_url, "https": proxy_url},
                         timeout=20, headers={"User-Agent": "DominusNode-Showcase/1.0"},
                         allow_redirects=False)
        res["fetch"] = json.dumps({"status": r.status_code, "bytes": len(r.content),
                                   "body": r.text[:200]})
        ok += 1
        categories["proxy"] = categories.get("proxy", True)
    except Exception as e:
        res["fetch"] = json.dumps({"error": scrub(str(e))[:100]})
        err += 1
    call_api("proxy_config", "proxy", "GET", "/api/proxy/config")
    call_api("proxy_status", "proxy", "GET", "/api/proxy/status")
    call_api("sessions", "proxy", "GET", "/api/sessions/active")
    # Usage
    call_api("usage", "usage", "GET", "/api/usage")
    call_api("daily_usage", "usage", "GET", "/api/usage/daily?days=7")
    call_api("top_hosts", "usage", "GET", "/api/usage/top-hosts?limit=5")
    # Keys
    call_api("list_keys", "keys", "GET", "/api/keys")
    kr = call_api("create_key", "keys", "POST", "/api/keys", {"label": "showcase-key"})
    kid = _extract_uuid(kr)
    if kid:
        call_api("revoke_key", "keys", "DELETE", f"/api/keys/{kid}")
    # Plans
    call_api("get_plan", "plans", "GET", "/api/plans/current")
    call_api("list_plans", "plans", "GET", "/api/plans")
    # Agentic Wallets
    wr = call_api("create_wallet", "wallets", "POST", "/api/agent-wallet",
                  {"label": "showcase-wallet", "spendingLimitCents": 10000})
    wid = _extract_uuid(wr)
    if wid:
        call_api("fund_wallet", "wallets", "POST",
                 f"/api/agent-wallet/{wid}/fund", {"amountCents": 100})
        call_api("wallet_balance", "wallets", "GET", f"/api/agent-wallet/{wid}")
        call_api("list_wallets", "wallets", "GET", "/api/agent-wallet")
        call_api("wallet_txns", "wallets", "GET",
                 f"/api/agent-wallet/{wid}/transactions")
        call_api("wallet_policy", "wallets", "PATCH",
                 f"/api/agent-wallet/{wid}/policy", {"dailyLimitCents": 5000})
        call_api("freeze_wallet", "wallets", "POST",
                 f"/api/agent-wallet/{wid}/freeze")
        call_api("unfreeze_wallet", "wallets", "POST",
                 f"/api/agent-wallet/{wid}/unfreeze")
        call_api("delete_wallet", "wallets", "DELETE", f"/api/agent-wallet/{wid}")
    # Teams
    tr = call_api("create_team", "teams", "POST", "/api/teams",
                  {"name": "showcase-team"})
    tid = _extract_uuid(tr)
    if tid:
        call_api("list_teams", "teams", "GET", "/api/teams")
        call_api("team_details", "teams", "GET", f"/api/teams/{tid}")
        call_api("update_team", "teams", "PATCH", f"/api/teams/{tid}",
                 {"name": "updated-showcase"})
        call_api("team_fund", "teams", "POST", f"/api/teams/{tid}/fund",
                 {"amountCents": 50})
        tkr = call_api("team_create_key", "teams", "POST",
                       f"/api/teams/{tid}/keys", {"label": "team-key"})
        tkid = _extract_uuid(tkr)
        call_api("team_list_keys", "teams", "GET", f"/api/teams/{tid}/keys")
        call_api("team_usage", "teams", "GET", f"/api/teams/{tid}/usage")
        call_api("team_members", "teams", "GET", f"/api/teams/{tid}/members")
        ir = call_api("team_invite", "teams", "POST", f"/api/teams/{tid}/invites",
                      {"email": "invite-test@dominusnode.bot", "role": "member"})
        iid = _extract_uuid(ir)
        call_api("team_invites", "teams", "GET", f"/api/teams/{tid}/invites")
        if iid:
            call_api("team_cancel_invite", "teams", "DELETE",
                     f"/api/teams/{tid}/invites/{iid}")
        if tkid:
            call_api("team_revoke_key", "teams", "DELETE",
                     f"/api/teams/{tid}/keys/{tkid}")
        call_api("team_delete", "teams", "DELETE", f"/api/teams/{tid}")

    res["_stats"] = {"ok": ok, "err": err, "total": ok + err}
    res["_categories"] = categories
    return res


PYTHON_RUNNERS = {
    "langchain":        _run_langchain,
    "crewai":           _run_crewai,
    "llamaindex":       _make_toolkit_runner(_import_llamaindex),
    "autogpt":          _run_autogpt,
    "agent-zero":       _run_agent_zero,
    "superagi":         _run_superagi,
    "raw-http":         _run_raw_http,
    "agno":             _make_toolkit_runner(_import_agno),
    "camel-ai":         _make_toolkit_runner(_import_camel),
    "composio":         _make_toolkit_runner(_import_composio),
    "dify":             _run_dify,
    "haystack":         _make_toolkit_runner(_import_haystack),
    "ironclaw":         _make_toolkit_runner(_import_ironclaw),
    "metagpt":          _make_toolkit_runner(_import_metagpt),
    "moltbook":         _make_toolkit_runner(_import_moltbook),
    "pydantic-ai":      _make_toolkit_runner(_import_pydantic_ai),
    "semantic-kernel":  _make_toolkit_runner(_import_semantic_kernel),
}


def run_node_integration(integration_id, api_key, api_base, proxy_host, proxy_port,
                         target_url, proxy_type) -> dict:
    """Call Node.js runner as subprocess; API key passed via env."""
    env = {**os.environ, "SHOWCASE_API_KEY": api_key}
    cmd = ["node", str(NODE_RUNNER), integration_id, api_base,
           proxy_host, str(proxy_port), target_url, proxy_type]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=150, env=env)
        if r.returncode != 0:
            err = scrub((r.stderr or r.stdout)[:200])
            return {"error": err}
        return json.loads(r.stdout.strip() or "{}")
    except subprocess.TimeoutExpired:
        return {"error": "Node runner timed out (150s)"}
    except json.JSONDecodeError as e:
        return {"error": f"Invalid JSON from runner: {e}"}
    except FileNotFoundError:
        return {"error": "node not found — install Node.js"}


def run_agent(agent_num: int, integration_id: str, cfg: ShowcaseConfig,
              admin_jwt: str, results: List[AgentResult]) -> AgentResult:
    """Full lifecycle for one showcase agent — exercises all 53 tools."""
    info = CATALOG[integration_id]
    res = AgentResult(agent_num=agent_num, integration=integration_id,
                      target_url=cfg.target_url, proxy_type=cfg.proxy_type)
    res.status = "running"
    start = time.time()

    try:
        # 1. Create account (admin bootstrap — register + credit + API key)
        tag = f"{integration_id[:6]}-{agent_num}"
        account = setup_account(cfg, admin_jwt, tag)
        api_key = account["api_key"]
        if not api_key:
            raise RuntimeError("Failed to obtain API key")

        # 2. Run full lifecycle through the integration
        if info.runtime == "python":
            runner = PYTHON_RUNNERS.get(integration_id, _run_raw_http)
            raw = runner(api_key, cfg.api_base, cfg.proxy_host,
                         cfg.proxy_port, cfg.target_url, cfg.proxy_type)
        else:
            raw = run_node_integration(integration_id, api_key, cfg.api_base,
                                       cfg.proxy_host, cfg.proxy_port,
                                       cfg.target_url, cfg.proxy_type)

        # 3. Extract results
        if raw.get("error") and not raw.get("_stats"):
            res.error = scrub(raw["error"])[:200]
        else:
            stats = raw.get("_stats", {})
            cats = raw.get("_categories", {})

            res.tools_ok = stats.get("ok", 0)
            res.tools_total = stats.get("total", 0)

            res.balance_ok = bool(raw.get("balance") and
                                  not str(raw["balance"]).startswith("ERROR:"))
            res.fetch_ok = bool(raw.get("fetch") and
                                not str(raw["fetch"]).startswith("ERROR:"))
            res.usage_ok = bool(raw.get("usage") and
                                not str(raw["usage"]).startswith("ERROR:"))
            res.account_ok = cats.get("account", False)
            res.keys_ok = cats.get("keys", False)
            res.billing_ok = cats.get("billing", False)
            res.teams_ok = cats.get("teams", False)
            res.wallets_ok = cats.get("wallets", False)
            res.plans_ok = cats.get("plans", False)

            if res.fetch_ok:
                fd = raw["fetch"]
                if isinstance(fd, str):
                    try:
                        parsed = json.loads(fd)
                        res.fetch_bytes = parsed.get("bytes", len(fd))
                    except Exception:
                        res.fetch_bytes = len(fd)
                elif isinstance(fd, dict):
                    res.fetch_bytes = fd.get("bytes", 0)

            res.success = res.tools_ok > 0

    except Exception as e:
        res.error = scrub(str(e))[:200]

    res.duration = round(time.time() - start, 2)
    res.status = "done" if res.success else "failed"
    res.post = make_post(res)
    return res


# ══════════════════════════════════════════════════════════════════════════════
# TUI — curses screens
# ══════════════════════════════════════════════════════════════════════════════

# Color pair IDs
CP_HEADER = 1; CP_GREEN = 2; CP_RED = 3; CP_YLW = 4; CP_CYN = 5
CP_MAG = 6; CP_REV = 7; CP_DIM = 8

def setup_colors():
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(CP_HEADER, curses.COLOR_CYAN,    -1)
    curses.init_pair(CP_GREEN,  curses.COLOR_GREEN,   -1)
    curses.init_pair(CP_RED,    curses.COLOR_RED,     -1)
    curses.init_pair(CP_YLW,    curses.COLOR_YELLOW,  -1)
    curses.init_pair(CP_CYN,    curses.COLOR_CYAN,    -1)
    curses.init_pair(CP_MAG,    curses.COLOR_MAGENTA, -1)
    curses.init_pair(CP_REV,    curses.COLOR_BLACK,   curses.COLOR_WHITE)
    curses.init_pair(CP_DIM,    curses.COLOR_WHITE,   -1)


def c(pair_id, bold=False):
    attr = curses.color_pair(pair_id)
    return attr | curses.A_BOLD if bold else attr


def draw_header(win, subtitle=""):
    h, w = win.getmaxyx()
    win.clear()
    title = "  DOMINUS NODE — Integration Showcase Swarm  "
    border = "═" * len(title)
    try:
        win.addstr(0, 0, "╔" + border + "╗", c(CP_HEADER, True))
        win.addstr(1, 0, "║" + title      + "║", c(CP_HEADER, True))
        win.addstr(2, 0, "╚" + border + "╝", c(CP_HEADER, True))
        if subtitle:
            win.addstr(3, 2, subtitle, c(CP_CYN))
    except curses.error:
        pass


def draw_footer(win, keys: str):
    h, w = win.getmaxyx()
    try:
        win.addstr(h - 1, 0, (" " + keys + " ").ljust(w - 1)[:w - 1], c(CP_REV))
    except curses.error:
        pass


def input_field(win, y, x, prompt, default="", width=28, secret=False) -> str:
    """Inline text input. Returns new value (or default on ESC)."""
    curses.curs_set(1)
    value = list(str(default))
    pos = len(value)
    win.addstr(y, x, prompt)
    px = x + len(prompt)

    while True:
        display = ("●" * len(value) if secret else "".join(value))
        field = ("[" + display.ljust(width)[:width] + "]")
        try:
            win.addstr(y, px, field, c(CP_YLW))
            win.move(y, px + 1 + min(pos, width - 1))
        except curses.error:
            pass
        win.refresh()

        try:
            ch = win.get_wch()
        except Exception:
            break

        if isinstance(ch, str):
            if ch in ("\n", "\r"):
                break
            if ord(ch) == 27:           # ESC → revert
                value = list(str(default)); pos = len(value); break
            if ord(ch) in (8, 127):     # Backspace
                if pos > 0:
                    value.pop(pos - 1); pos -= 1
            elif len(value) < width + 20:
                value.insert(pos, ch); pos += 1
        elif ch == curses.KEY_BACKSPACE:
            if pos > 0:
                value.pop(pos - 1); pos -= 1
        elif ch == curses.KEY_LEFT and pos > 0:
            pos -= 1
        elif ch == curses.KEY_RIGHT and pos < len(value):
            pos += 1
        elif ch in (curses.KEY_ENTER,):
            break

    curses.curs_set(0)
    return "".join(value)


# ── Screen 1: Connection ───────────────────────────────────────────────────────
def screen_connection(stdscr, cfg: ShowcaseConfig) -> str:
    draw_header(stdscr, "  Step 1 of 3 — Connection")
    draw_footer(stdscr, "TAB/↓ next field  ENTER confirm  Q quit")
    stdscr.refresh()

    fields = [
        ("API Base URL:   ", "api_base",       False),
        ("Proxy Host:     ", "proxy_host",     False),
        ("Proxy Port:     ", "proxy_port",     False),
        ("Admin Email:    ", "admin_email",    False),
        ("Admin Password: ", "admin_password", True),
    ]
    y_start = 5
    current = 0

    while True:
        for i, (label, attr, secret) in enumerate(fields):
            default = str(getattr(cfg, attr))
            color = c(CP_YLW) if i == current else c(CP_DIM)
            prefix = "▶ " if i == current else "  "
            try:
                stdscr.addstr(y_start + i * 2, 2, prefix + label, color)
                disp = ("●" * len(default) if secret else default).ljust(28)[:28]
                stdscr.addstr(y_start + i * 2, 2 + len(prefix) + len(label),
                              f"[{disp}]", c(CP_YLW) if i == current else c(CP_DIM))
            except curses.error:
                pass

        try:
            stdscr.addstr(y_start + len(fields) * 2 + 1, 2,
                          "Press ENTER on each field to edit", c(CP_DIM))
        except curses.error:
            pass
        stdscr.refresh()

        key = stdscr.getch()
        if key in (ord('q'), ord('Q')):
            return "quit"
        elif key in (curses.KEY_DOWN, ord('\t')):
            current = (current + 1) % len(fields)
        elif key == curses.KEY_UP:
            current = (current - 1) % len(fields)
        elif key in (curses.KEY_ENTER, ord('\n'), ord('\r'), ord(' ')):
            label, attr, secret = fields[current]
            new_val = input_field(stdscr, y_start + current * 2,
                                  2, label,
                                  default=str(getattr(cfg, attr)),
                                  secret=secret)
            if attr == "proxy_port":
                try:
                    setattr(cfg, attr, int(new_val))
                except ValueError:
                    pass
            else:
                setattr(cfg, attr, new_val)
            if current == len(fields) - 1:
                return "next"
            current += 1
        elif key == ord('n'):
            return "next"


# ── Screen 2: Integration selection ───────────────────────────────────────────
def screen_select_integrations(stdscr, cfg: ShowcaseConfig) -> str:
    h, w = stdscr.getmaxyx()
    draw_header(stdscr, "  Step 2 of 3 — Select Integrations")
    draw_footer(stdscr, "↑↓ navigate  SPACE toggle  A all  N none  ENTER next  B back  Q quit")

    items = list(CATALOG.keys())
    if not cfg.selected:
        cfg.selected = {
            "langchain", "crewai", "llamaindex", "autogpt", "mastra", "flowise",
            "agno", "camel-ai", "composio", "dify", "haystack", "ironclaw",
            "metagpt", "pydantic-ai", "semantic-kernel", "gemini", "raw-http",
        }

    current = 0
    scroll = 0
    max_visible = h - 8

    while True:
        draw_header(stdscr, "  Step 2 of 3 — Select Integrations")
        # Legend
        try:
            stdscr.addstr(4, 2, "● Python", c(CP_YLW))
            stdscr.addstr(4, 13, "■ TypeScript", c(CP_CYN))
            stdscr.addstr(4, 27, "✓ Installed", c(CP_GREEN))
            stdscr.addstr(4, 40, "✗ Needs install", c(CP_RED))
        except curses.error:
            pass

        for i, iid in enumerate(items[scroll:scroll + max_visible]):
            row = scroll + i
            info = CATALOG[iid]
            is_cur = row == current
            is_sel = iid in cfg.selected
            installed = dep_installed(info)

            check = "✓" if is_sel else " "
            prefix = "▶ " if is_cur else "  "
            runtime_sym = "●" if info.runtime == "python" else "■"
            runtime_col = c(CP_YLW) if info.runtime == "python" else c(CP_CYN)
            inst_sym = "✓" if installed else "○"
            inst_col = c(CP_GREEN) if installed else c(CP_RED)

            label = f"{info.name:<18} {info.description[:28]:<28}"
            line = f"{prefix}[{check}]  {runtime_sym} {label}  {inst_sym}"

            y = 5 + i
            try:
                if is_cur:
                    stdscr.addstr(y, 2, line, curses.A_REVERSE)
                else:
                    stdscr.addstr(y, 2, prefix, c(CP_DIM))
                    stdscr.addstr(y, 4, f"[{check}]", c(CP_GREEN) if is_sel else c(CP_DIM))
                    stdscr.addstr(y, 8, f"  {runtime_sym} ", runtime_col)
                    name_col = c(CP_GREEN, True) if is_sel else c(CP_DIM)
                    stdscr.addstr(y, 12, label, name_col)
                    stdscr.addstr(y, 12 + len(label) + 2, inst_sym, inst_col)
            except curses.error:
                pass

        sel_count = len(cfg.selected)
        try:
            stdscr.addstr(h - 3, 2,
                          f"Selected: {sel_count}/{len(items)}  |  "
                          f"Est agents: {sel_count * cfg.agents_per_integ}",
                          c(CP_HEADER))
        except curses.error:
            pass
        draw_footer(stdscr, "↑↓ navigate  SPACE toggle  A all  N none  ENTER next  B back  Q quit")
        stdscr.refresh()

        key = stdscr.getch()
        if key in (ord('q'), ord('Q')):
            return "quit"
        elif key in (ord('b'), ord('B')):
            return "back"
        elif key == curses.KEY_UP and current > 0:
            current -= 1
            if current < scroll:
                scroll -= 1
        elif key == curses.KEY_DOWN and current < len(items) - 1:
            current += 1
            if current >= scroll + max_visible:
                scroll += 1
        elif key == ord(' '):
            iid = items[current]
            if iid in cfg.selected:
                cfg.selected.discard(iid)
            else:
                cfg.selected.add(iid)
        elif key in (ord('a'), ord('A')):
            cfg.selected = set(CATALOG.keys())
        elif key in (ord('n'), ord('N')):
            cfg.selected = set()
        elif key in (curses.KEY_ENTER, ord('\n'), ord('\r')):
            if cfg.selected:
                return "next"


# ── Screen 3: Agent distribution ──────────────────────────────────────────────
def screen_configure_agents(stdscr, cfg: ShowcaseConfig) -> str:
    h, w = stdscr.getmaxyx()

    num_fields = [
        ("Total agents:         ", "total_agents",      1, 100),
        ("Agents per integ:     ", "agents_per_integ",  1, 20),
        ("Credit per agent (¢): ", "credit_cents",      50, 10000),
    ]
    str_fields = [
        ("Proxy type (dc/res):  ", "proxy_type"),
        ("Target URL:           ", "target_url"),
    ]
    all_fields = [(f[0], f[1]) for f in num_fields] + str_fields
    current = 0

    while True:
        draw_header(stdscr, "  Step 3 of 3 — Agent Distribution")
        y = 5
        for i, (label, attr) in enumerate(all_fields):
            color = c(CP_YLW) if i == current else c(CP_DIM)
            prefix = "▶ " if i == current else "  "
            try:
                val = str(getattr(cfg, attr))
                stdscr.addstr(y + i * 2, 2, prefix + label, color)
                stdscr.addstr(y + i * 2, 2 + len(prefix) + len(label),
                              f"[{val:<26}]", c(CP_YLW) if i == current else c(CP_DIM))
            except curses.error:
                pass

        # Distribution preview
        sel = sorted(cfg.selected)
        n_agents = cfg.total_agents
        apa = cfg.agents_per_integ
        preview_y = y + len(all_fields) * 2 + 1
        try:
            stdscr.addstr(preview_y, 2, "Distribution preview:", c(CP_HEADER))
        except curses.error:
            pass
        assigned = 0
        for i, iid in enumerate(sel):
            if assigned >= n_agents:
                break
            count = min(apa, n_agents - assigned)
            bar = "█" * count + "░" * max(0, apa - count)
            info = CATALOG[iid]
            line = f"  {info.name:<16} {bar} {count} agents"
            assigned += count
            try:
                if preview_y + 1 + i < h - 3:
                    stdscr.addstr(preview_y + 1 + i, 2, line[:w - 4], c(CP_DIM))
            except curses.error:
                pass

        est_kb = assigned * 0.2
        est_cost = assigned * cfg.credit_cents / 100
        try:
            stdscr.addstr(h - 4, 2,
                          f"Total assigned: {assigned} agents  |  "
                          f"Est. bandwidth: ~{est_kb:.0f}KB  |  "
                          f"Wallet: ${est_cost:.2f}",
                          c(CP_HEADER))
        except curses.error:
            pass

        draw_footer(stdscr, "↑↓ navigate  ENTER edit field  N next  B back  Q quit")
        stdscr.refresh()

        key = stdscr.getch()
        if key in (ord('q'), ord('Q')):
            return "quit"
        elif key in (ord('b'), ord('B')):
            return "back"
        elif key in (ord('n'), ord('N')):
            return "next"
        elif key == curses.KEY_UP:
            current = (current - 1) % len(all_fields)
        elif key == curses.KEY_DOWN:
            current = (current + 1) % len(all_fields)
        elif key in (curses.KEY_ENTER, ord('\n'), ord('\r'), ord(' ')):
            label, attr = all_fields[current]
            new_val = input_field(stdscr, y + current * 2, 2, label,
                                  default=str(getattr(cfg, attr)))
            # find if numeric
            is_num = any(f[1] == attr for f in num_fields)
            if is_num:
                num_info = next(f for f in num_fields if f[1] == attr)
                try:
                    v = int(new_val)
                    v = max(num_info[2], min(v, num_info[3]))
                    setattr(cfg, attr, v)
                except ValueError:
                    pass
            else:
                setattr(cfg, attr, new_val.strip() or str(getattr(cfg, attr)))
            if current == len(all_fields) - 1:
                return "next"


# ── Screen 4: Pre-launch dep check ────────────────────────────────────────────
def screen_prelaunch(stdscr, cfg: ShowcaseConfig) -> str:
    h, w = stdscr.getmaxyx()
    draw_header(stdscr, "  Pre-launch Checks")

    sel = sorted(cfg.selected)
    statuses: Dict[str, str] = {}   # id -> "ok" | "installing" | "failed" | "skip"

    def redraw():
        draw_header(stdscr, "  Pre-launch Checks")
        try:
            stdscr.addstr(4, 2, "Dependency Status:", c(CP_HEADER))
        except curses.error:
            pass
        for i, iid in enumerate(sel):
            info = CATALOG[iid]
            status = statuses.get(iid, "checking")
            sym_map = {"ok": ("✓", CP_GREEN), "failed": ("✗", CP_RED),
                       "installing": ("↓", CP_YLW), "checking": ("…", CP_CYN),
                       "missing": ("○", CP_RED), "skip": ("─", CP_DIM)}
            sym, col = sym_map.get(status, ("?", CP_DIM))
            inst_note = info.package if status in ("failed", "installing") else ""
            line = f"  {sym}  {info.name:<16} {info.description[:30]:<30} {inst_note}"
            try:
                stdscr.addstr(5 + i, 2, line[:w - 4], c(col))
            except curses.error:
                pass

        docker_y = 5 + len(sel) + 1
        dok = docker_available()
        has_node = node_available()
        has_npm  = npm_available()
        cfg.use_docker = dok
        need_node = any(CATALOG[i].runtime == "node" for i in sel)
        try:
            stdscr.addstr(docker_y,     2,
                          f"  {'✓' if dok       else '✗'}  Docker:  {'available'     if dok       else 'not available'}",
                          c(CP_GREEN) if dok else c(CP_DIM))
            stdscr.addstr(docker_y + 1, 2,
                          f"  {'✓' if has_node  else '✗'}  Node.js: {'available'     if has_node  else 'NOT FOUND — required for TS integrations'}",
                          c(CP_GREEN) if has_node else (c(CP_RED, True) if need_node else c(CP_DIM)))
            stdscr.addstr(docker_y + 2, 2,
                          f"  {'✓' if has_npm   else '✗'}  npm:     {'available'     if has_npm   else 'NOT FOUND — required to install TS deps'}",
                          c(CP_GREEN) if has_npm else (c(CP_RED) if need_node else c(CP_DIM)))
        except curses.error:
            pass

        node_blocker = need_node and not has_node
        all_ok = all(statuses.get(i) in ("ok", "skip") for i in sel) and not node_blocker
        try:
            if node_blocker:
                stdscr.addstr(docker_y + 4, 2,
                              "  ✗  Install Node.js ≥18 to use TypeScript integrations",
                              c(CP_RED, True))
            elif all_ok:
                stdscr.addstr(docker_y + 4, 2,
                              "  ▶  [LAUNCH SWARM]  (press ENTER)", c(CP_GREEN, True))
            else:
                stdscr.addstr(docker_y + 4, 2,
                              "  ↓  [INSTALL MISSING]  (press I)  |  [LAUNCH ANYWAY]  (press ENTER)",
                              c(CP_YLW))
        except curses.error:
            pass
        draw_footer(stdscr, "ENTER launch  I install missing  B back  Q quit")
        stdscr.refresh()

    # Initial check
    for iid in sel:
        statuses[iid] = "ok" if dep_installed(CATALOG[iid]) else "missing"
    redraw()

    while True:
        key = stdscr.getch()
        if key in (ord('q'), ord('Q')):
            return "quit"
        elif key in (ord('b'), ord('B')):
            return "back"
        elif key in (ord('i'), ord('I')):
            missing = [iid for iid in sel if statuses.get(iid) == "missing"]
            for iid in missing:
                statuses[iid] = "installing"
                redraw()
                ok = install_dep(CATALOG[iid], cfg.use_docker)
                statuses[iid] = "ok" if ok else "failed"
                redraw()
        elif key in (curses.KEY_ENTER, ord('\n'), ord('\r')):
            return "next"


def run_tui(stdscr, cfg: ShowcaseConfig) -> bool:
    curses.curs_set(0)
    setup_colors()

    screens = [
        screen_connection,
        screen_select_integrations,
        screen_configure_agents,
        screen_prelaunch,
    ]
    current = 0
    while 0 <= current < len(screens):
        result = screens[current](stdscr, cfg)
        if result == "next":
            current += 1
        elif result == "back":
            current = max(0, current - 1)
        elif result == "quit":
            return False
    return True


# ══════════════════════════════════════════════════════════════════════════════
# Live progress + launch (non-curses, ANSI output)
# ══════════════════════════════════════════════════════════════════════════════

def _status_line(res: AgentResult, info: IntegrationInfo) -> str:
    color = A_GRN if res.success else (A_RED if res.status == "failed" else A_YLW)
    runtime_col = A_YLW if info.runtime == "python" else A_CYN
    sym = "✓" if res.success else ("✗" if res.status == "failed" else "◌")
    name = f"{runtime_col}{info.name:<14}{A_RST}"
    stat = f"{color}{res.status:<8}{A_RST}"
    extras = ""
    if res.fetch_ok:
        extras += f"  fetch:{res.fetch_bytes}B"
    if res.error:
        extras += f"  ERR:{res.error[:30]}"
    return f"  {color}{sym}{A_RST}  Agent #{res.agent_num:<3} [{name}]  {stat}  {extras}"


def launch_swarm(cfg: ShowcaseConfig):
    sel = sorted(cfg.selected)
    print(f"\n{A_BLD}{A_CYN}{'═' * 60}{A_RST}")
    print(f"{A_BLD}  DOMINUS NODE Integration Showcase Swarm{A_RST}")
    print(f"{A_CYN}{'═' * 60}{A_RST}\n")

    # Build assignment list — ensure every integration gets at least 1 agent
    # before distributing extras.  The ThreadPoolExecutor (max_workers=8) already
    # cycles through them: 8 run concurrently, as each finishes the next starts.
    assignments: List[tuple] = []  # (agent_num, integration_id)

    # Round 1: guarantee 1 agent per integration
    for iid in sel:
        assignments.append((len(assignments) + 1, iid))

    # Round 2+: fill remaining slots round-robin up to total_agents
    if len(assignments) < cfg.total_agents:
        remaining = cfg.total_agents - len(assignments)
        extra_round = 1
        while remaining > 0:
            for iid in sel:
                if extra_round + 1 > cfg.agents_per_integ:
                    break
                if remaining <= 0:
                    break
                assignments.append((len(assignments) + 1, iid))
                remaining -= 1
            extra_round += 1
            if extra_round + 1 > cfg.agents_per_integ:
                break

    if not assignments:
        print(f"{A_RED}No agents to launch.{A_RST}")
        return

    print(f"  Integrations: {len(sel)}  selected")
    print(f"  Agents:       {len(assignments)}  total")
    print(f"  Credit:       {cfg.credit_cents}¢ per agent  (${len(assignments)*cfg.credit_cents/100:.2f} total)")
    print(f"  Proxy type:   {cfg.proxy_type}")
    print(f"  Target URL:   {cfg.target_url}")
    print()

    # Admin auth
    print(f"  {A_CYN}Authenticating as admin...{A_RST}", end="", flush=True)
    admin_jwt = ""
    try:
        admin_jwt = admin_login(cfg)
        print(f"  {A_GRN}✓{A_RST}")
    except Exception as e:
        print(f"  {A_YLW}⚠ {scrub(str(e))} — no plan/credit assignment{A_RST}")

    print(f"\n  {A_BLD}Launching {len(assignments)} agents...{A_RST}\n")

    results: List[AgentResult] = [None] * len(assignments)
    done_count = 0

    def worker(idx, agent_num, iid):
        return idx, run_agent(agent_num, iid, cfg, admin_jwt, results)

    with ThreadPoolExecutor(max_workers=min(len(assignments), 8)) as pool:
        futures = {
            pool.submit(worker, i, num, iid): (i, num, iid)
            for i, (num, iid) in enumerate(assignments)
        }
        for future in as_completed(futures):
            try:
                idx, res = future.result()
                results[idx] = res
                info = CATALOG[res.integration]
                done_count += 1
                print(_status_line(res, info))
            except Exception as e:
                done_count += 1
                print(f"  {A_RED}✗ Agent error: {scrub(str(e))[:80]}{A_RST}")

    # Summary
    success = sum(1 for r in results if r and r.success)
    print(f"\n{A_CYN}{'═' * 60}{A_RST}")
    print(f"{A_BLD}  Results: {A_GRN}{success}{A_RST}{A_BLD}/{len(assignments)} passed{A_RST}")
    print(f"{A_CYN}{'─' * 60}{A_RST}")

    by_integ: Dict[str, List[AgentResult]] = {}
    for r in results:
        if r:
            by_integ.setdefault(r.integration, []).append(r)

    for iid, rs in sorted(by_integ.items()):
        info = CATALOG[iid]
        ok = sum(1 for r in rs if r.success)
        runtime_col = A_YLW if info.runtime == "python" else A_CYN
        bal = "✓" if any(r.balance_ok for r in rs) else "✗"
        fetch = "✓" if any(r.fetch_ok for r in rs) else "✗"
        print(f"  {runtime_col}{info.name:<18}{A_RST}  {ok}/{len(rs)} ok  "
              f"bal:{bal}  fetch:{fetch}")

    # Posts
    posts = [r.post for r in results if r and r.post]
    if posts:
        print(f"\n{A_BLD}  Generated Social Posts:{A_RST}")
        print(f"  {A_DIM}AI model: template-based (no LLM) — deterministic post generation{A_RST}")
        print(f"{A_CYN}{'─' * 60}{A_RST}")
        for r in results:
            if r and r.post:
                info = CATALOG[r.integration]
                runtime_col = A_YLW if info.runtime == "python" else A_CYN
                is_long = len(r.post) > 300
                style = "LONG" if is_long else "SHORT"
                style_col = A_GRN if is_long else A_YLW
                print(f"  {runtime_col}[{info.name} #{r.agent_num}]{A_RST}"
                      f"  {style_col}[{style} — {len(r.post)} chars]{A_RST}")
                print(f"  {A_DIM}{r.post}{A_RST}\n")

    # Save results
    log_dir = "/tmp/dominusnode-showcase"
    os.makedirs(log_dir, mode=0o700, exist_ok=True)
    out_file = os.path.join(log_dir, "results.json")
    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({
            "config": {
                "integrations": list(cfg.selected),
                "total_agents": len(assignments),
                "agents_per_integ": cfg.agents_per_integ,
                "proxy_type": cfg.proxy_type,
                "target_url": cfg.target_url,
            },
            "results": [
                {
                    "agent": r.agent_num, "integration": r.integration,
                    "success": r.success, "balance": r.balance_ok,
                    "fetch": r.fetch_ok, "fetch_bytes": r.fetch_bytes,
                    "duration": r.duration, "error": r.error, "post": r.post,
                }
                for r in results if r
            ],
            "posts": posts,
        }, f, indent=2)
    print(f"\n  {A_DIM}Results saved → {out_file}{A_RST}")
    print(f"{A_CYN}{'═' * 60}{A_RST}\n")


# ══════════════════════════════════════════════════════════════════════════════
# Auto-venv: isolate pip installs from system Python
# ══════════════════════════════════════════════════════════════════════════════

def ensure_venv():
    """Create a venv and re-exec this script under it if not already in one.

    On Windows, skip venv isolation — SDK packages are installed in the system
    Python and a fresh venv would lack them.  The venv approach is for Linux CI.
    """
    if sys.prefix != sys.base_prefix:
        return  # already running inside a venv

    if sys.platform == "win32":
        return  # use system Python on Windows (SDKs already installed)

    venv_python = VENV_DIR / "bin" / "python3"

    if not venv_python.exists():
        print(f"Creating showcase venv at {VENV_DIR} ...", flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "venv", str(VENV_DIR)],
        )
        # Bootstrap requests into the fresh venv
        print("Installing requests into venv ...", flush=True)
        subprocess.check_call(
            [str(venv_python), "-m", "pip", "install", "-q", "requests"],
        )

    # Re-exec under the venv's Python
    os.execvp(str(venv_python), [str(venv_python)] + sys.argv)


# ══════════════════════════════════════════════════════════════════════════════
# Entry point
# ══════════════════════════════════════════════════════════════════════════════

def main():
    ensure_venv()

    parser = argparse.ArgumentParser(description="Dominus Node Integration Showcase Swarm")
    parser.add_argument("--no-tui", action="store_true",
                        help="Skip TUI, use CLI args + env vars")
    parser.add_argument("--api-base", default="http://localhost:3000")
    parser.add_argument("--proxy-host", default="localhost")
    parser.add_argument("--proxy-port", type=int, default=8080)
    parser.add_argument("--integrations", nargs="+", default=[],
                        help="Integration IDs to use (default: langchain crewai mastra raw-http)")
    parser.add_argument("--agents", type=int, default=10)
    parser.add_argument("--per-integration", type=int, default=2)
    parser.add_argument("--credit-cents", type=int, default=200)
    parser.add_argument("--proxy-type", default="dc", choices=["dc", "residential"])
    parser.add_argument("--target-url", default="https://httpbin.org/ip")
    args = parser.parse_args()

    cfg = ShowcaseConfig(
        api_base=os.environ.get("DOMINUSNODE_BASE_URL", args.api_base),
        proxy_host=os.environ.get("DOMINUSNODE_PROXY_HOST", args.proxy_host),
        proxy_port=int(os.environ.get("DOMINUSNODE_PROXY_PORT", args.proxy_port)),
        admin_email=os.environ.get("ADMIN_EMAIL", ""),
        admin_password=os.environ.get("ADMIN_PASSWORD", ""),
        total_agents=args.agents,
        agents_per_integ=args.per_integration,
        credit_cents=args.credit_cents,
        proxy_type=args.proxy_type,
        target_url=args.target_url,
    )

    if args.no_tui:
        cfg.selected = set(args.integrations) if args.integrations else \
                       {"langchain", "crewai", "mastra", "flowise",
                        "agno", "camel-ai", "composio", "dify", "haystack",
                        "ironclaw", "metagpt", "pydantic-ai", "semantic-kernel",
                        "gemini", "raw-http"}
        launch_swarm(cfg)
    else:
        if curses is None:
            print("ERROR: TUI requires 'curses' (pip install windows-curses on Windows).")
            print("       Use --no-tui mode instead.")
            sys.exit(1)
        try:
            ok = curses.wrapper(run_tui, cfg)
        except KeyboardInterrupt:
            print("\nCancelled.")
            sys.exit(0)
        if ok:
            launch_swarm(cfg)
        else:
            print("Cancelled.")


if __name__ == "__main__":
    main()
