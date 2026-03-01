#!/usr/bin/env python3
"""
DomiNode AI Swarm Orchestrator

Uses a local AI model (via OpenAI-compatible API) to create and manage
autonomous DomiNode agents. Each agent registers, gets an API key,
uses the proxy, and generates social posts about the experience.

Architecture:
  ONE model instance on GPU (SGLang/vLLM/Ollama) serves ALL agent threads.
  This is NOT one model per agent — SGLang handles concurrent requests via
  batched inference and RadixAttention (shared prefix caching).

  VRAM budget (32GB RTX 5090 example):
    Model weights:  ~12GB (GLM-4-9B Q5) or ~5GB (Qwen3-8B Q4)
    KV cache:       ~4-8GB (scales with concurrent requests)
    CUDA overhead:  ~2GB
    ─────────────────────────────────────────────
    Total:          ~18-22GB → leaves headroom for 10-50 concurrent agents

  Flow:
    SGLang (1 model, GPU) ──→ OpenAI-compatible API (:8000)
         ↑                              ↓
    All N agent threads share this single inference endpoint
         ↓
    Each agent thread ──→ DomiNode API (:3000) ──→ Proxy Gateway (:8080)

Modes:
  - team:  Creates one team, shared wallet, agents use team API keys
  - solo:  Each agent registers independently with own wallet
  - both:  70% team + 30% solo (configurable)
"""

import argparse
import hashlib
import json
import logging
import os
import random
import re
import secrets
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# --- Optional imports (graceful fallback) ------------------------------------
try:
    import requests
except ImportError:
    print("ERROR: 'requests' package required. pip install requests")
    sys.exit(1)

try:
    from dominusnode import DominusNodeClient
except ImportError:
    DominusNodeClient = None
    print("WARNING: dominusnode SDK not installed. Using raw HTTP calls.")

# --- Configuration -----------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ai-swarm")

# Default to Ollama port (matches PowerShell launcher default)
AI_API_BASE = os.environ.get("AI_API_BASE", "http://localhost:11434/v1")
AI_MODEL = os.environ.get("AI_MODEL", "qwen3:8b")


# Safe integer parser with bounds validation
def safe_int(value: str, default: int, min_val: int = 0, max_val: int = 100000) -> int:
    """Parse int from string with validation and bounds."""
    try:
        n = int(value)
        return max(min_val, min(n, max_val))
    except (ValueError, TypeError):
        return default


# Scrub credentials from error messages
def scrub_credentials(msg: str) -> str:
    """Remove API keys, passwords, and JWTs from error strings."""
    msg = re.sub(r'dn_(live|test)_[a-zA-Z0-9]+', 'dn_***_REDACTED', msg)
    msg = re.sub(r'"password"\s*:\s*"[^"]*"', '"password":"***"', msg)
    msg = re.sub(r'eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+', 'JWT_REDACTED', msg)
    return msg

# Proxy request targets
DC_TARGETS = [
    "https://httpbin.org/ip",
    "https://httpbin.org/headers",
    "https://httpbin.org/get",
    "https://httpbin.org/status/200",
]

RES_TARGETS = [
    "https://www.google.com/search?q=dominusnode+proxy+api",
]


@dataclass
class AgentConfig:
    """Configuration for a single swarm agent."""
    agent_num: int
    email: str
    password: str
    api_base: str
    proxy_host: str
    proxy_port: int
    mode: str  # "team" or "solo"
    team_api_key: Optional[str] = None
    api_key: Optional[str] = None
    jwt: Optional[str] = None
    user_id: Optional[str] = None
    cycles: int = 5
    delay_sec: int = 5
    res_scrapes: int = 1
    dc_requests: int = 4


@dataclass
class SwarmResult:
    """Result from a single agent run."""
    agent_num: int
    mode: str
    success: bool
    res_requests: int = 0
    dc_requests: int = 0
    res_bytes: int = 0
    dc_bytes: int = 0
    posts_made: int = 0
    error: Optional[str] = None
    ai_post: Optional[str] = None


# --- AI Model Interface ------------------------------------------------------

def ai_generate(prompt: str, max_tokens: int = 512, temperature: float = 0.7) -> str:
    """Generate text using the local AI model via OpenAI-compatible API."""
    try:
        resp = requests.post(
            f"{AI_API_BASE}/chat/completions",
            json={
                "model": AI_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": temperature,
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log.warning("AI generation failed: %s. Using template fallback.", e)
        return ""


def ai_generate_post(agent_num: int, mode: str, stats: dict) -> str:
    """Use AI to generate a social media post about the agent's DomiNode experience."""
    prompt = f"""You are agent #{agent_num} in a DomiNode proxy swarm operating in {mode} mode.
You just completed a proxy session with these stats:
- Residential requests: {stats.get('res_requests', 0)}
- Datacenter requests: {stats.get('dc_requests', 0)}
- Total bandwidth: {stats.get('total_kb', 0)} KB
- Mode: {"team (shared wallet)" if mode == "team" else "solo (own account)"}

Write a short, enthusiastic social media post (under 280 characters) about your experience
using DomiNode's proxy infrastructure. Mention specific features like:
- Rotating proxies, smart pool routing (residential for Google/LinkedIn, DC for everything else)
- {"Team billing with shared wallet" if mode == "team" else "Individual account management"}
- SDKs available (Node, Python, Rust, Go, Java, C++)
- Real usage stats from above

Include #DomiNode and one other relevant hashtag. Be authentic, not spammy."""

    post = ai_generate(prompt, max_tokens=150, temperature=0.8)
    if not post:
        # Template fallback
        templates = [
            f"Agent #{agent_num} running on DomiNode ({mode} mode). "
            f"{stats.get('res_requests', 0)} residential + {stats.get('dc_requests', 0)} DC requests. "
            f"{stats.get('total_kb', 0)}KB total bandwidth. Smart routing saves 80% residential costs. "
            f"#DomiNode #AgentSwarm",

            f"Autonomous agent #{agent_num} completed {stats.get('cycles', 5)} proxy cycles via DomiNode. "
            f"{'Shared team wallet' if mode == 'team' else 'Personal wallet'} billing. "
            f"SDKs: Node/Python/Rust/Go/Java/C++. #DomiNode #ProxyAPI",
        ]
        post = random.choice(templates)
    return post[:280]


def ai_decide_action(agent_num: int, cycle: int, total_cycles: int, balance_info: str) -> str:
    """Ask AI to decide the next action for this cycle."""
    prompt = f"""You are autonomous proxy agent #{agent_num}, cycle {cycle}/{total_cycles}.
Current status: {balance_info}

What should you do this cycle? Choose ONE:
1. "scrape" — Make proxy requests (residential + datacenter)
2. "post" — Generate and post content about your experience
3. "check" — Check balance and usage stats

Reply with just the action word."""

    action = ai_generate(prompt, max_tokens=10, temperature=0.3).lower().strip()
    if action not in ("scrape", "post", "check"):
        # Default to scrape for most cycles, post on last
        return "post" if cycle == total_cycles else "scrape"
    return action


# --- DomiNode API Helpers ----------------------------------------------------

def api_request(method: str, url: str, jwt: str = "", json_data: dict = None) -> dict:
    """Make an API request to DomiNode."""
    headers = {"Content-Type": "application/json"}
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    try:
        resp = requests.request(method, url, headers=headers, json=json_data, timeout=30)
        return {"status": resp.status_code, "body": resp.json() if resp.text else {}}
    except Exception as e:
        # Scrub credentials from error messages
        return {"status": 0, "body": {"error": scrub_credentials(str(e))}}


def admin_login(api_base: str) -> str:
    """Authenticate as admin and return JWT."""
    email = os.environ.get("ADMIN_EMAIL", "")
    password = os.environ.get("ADMIN_PASSWORD", "")
    resp = api_request("POST", f"{api_base}/api/auth/login", json_data={
        "email": email, "password": password,
    })
    if resp["status"] != 200 or "token" not in resp["body"]:
        # Don't leak credentials in error messages
        raise RuntimeError(f"Admin login failed (status {resp['status']})")
    return resp["body"]["token"]


def register_agent(api_base: str, email: str, password: str) -> dict:
    """Register a new agent account."""
    resp = api_request("POST", f"{api_base}/api/auth/register", json_data={
        "email": email, "password": password,
    })
    return resp


def login_agent(api_base: str, email: str, password: str) -> str:
    """Login and return JWT."""
    resp = api_request("POST", f"{api_base}/api/auth/login", json_data={
        "email": email, "password": password,
    })
    if "token" not in resp["body"]:
        raise RuntimeError(f"Login failed for {email}")
    return resp["body"]["token"]


def get_user_id(api_base: str, jwt: str) -> str:
    """Get the user ID for the authenticated user."""
    resp = api_request("GET", f"{api_base}/api/auth/me", jwt=jwt)
    user = resp["body"].get("user", resp["body"])
    return user.get("id", "")


def create_api_key(api_base: str, jwt: str, label: str) -> str:
    """Create an API key and return the raw key."""
    resp = api_request("POST", f"{api_base}/api/keys", jwt=jwt, json_data={"label": label})
    return resp["body"].get("rawKey", resp["body"].get("key", ""))


def admin_assign_plan(api_base: str, admin_jwt: str, user_id: str, plan_id: str):
    """Admin assigns a plan to a user."""
    api_request("PUT", f"{api_base}/api/admin/users/{user_id}/plan", jwt=admin_jwt,
                json_data={"planId": plan_id})


def admin_credit_wallet(api_base: str, admin_jwt: str, user_id: str = "",
                        team_id: str = "", amount_cents: int = 500, reason: str = ""):
    """Admin credits a wallet."""
    data = {"amountCents": amount_cents, "reason": reason}
    if user_id:
        data["targetUserId"] = user_id
    elif team_id:
        data["teamId"] = team_id
    api_request("POST", f"{api_base}/api/admin/credit-wallet", jwt=admin_jwt, json_data=data)


def create_team(api_base: str, jwt: str, name: str, max_members: int) -> str:
    """Create a team and return the team ID."""
    resp = api_request("POST", f"{api_base}/api/teams", jwt=jwt, json_data={
        "name": name, "maxMembers": max_members,
    })
    team_id = resp["body"].get("id", resp["body"].get("team", {}).get("id", ""))
    if not team_id:
        # Try listing existing teams
        list_resp = api_request("GET", f"{api_base}/api/teams", jwt=jwt)
        teams = list_resp["body"].get("teams", [])
        if teams:
            team_id = teams[0].get("id", "")
    return team_id


def create_team_key(api_base: str, jwt: str, team_id: str, label: str) -> str:
    """Create a team API key."""
    resp = api_request("POST", f"{api_base}/api/teams/{team_id}/keys", jwt=jwt,
                       json_data={"label": label})
    return resp["body"].get("rawKey", "")


def get_balance(api_base: str, jwt: str) -> dict:
    """Get wallet balance."""
    resp = api_request("GET", f"{api_base}/api/wallet", jwt=jwt)
    return resp["body"]


# --- Proxy Request Logic -----------------------------------------------------

def do_proxy_request(url: str, api_key: str, proxy_host: str, proxy_port: int,
                     pool: str = "dc-country-US") -> dict:
    """Make a request through the DomiNode proxy."""
    proxy_url = f"http://{pool}:{api_key}@{proxy_host}:{proxy_port}"
    try:
        resp = requests.get(
            url,
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=60,
            headers={"User-Agent": "DomiNode-AI-Agent/1.0"},
        )
        return {
            "status": resp.status_code,
            "bytes": len(resp.content),
            "time": resp.elapsed.total_seconds(),
        }
    except Exception as e:
        # Scrub API key from error messages
        error_msg = scrub_credentials(str(e))
        if api_key and api_key in error_msg:
            error_msg = error_msg.replace(api_key, "***")
        return {"status": 0, "bytes": 0, "time": 0, "error": error_msg}


# --- Agent Runner ------------------------------------------------------------

def run_agent(config: AgentConfig, admin_jwt: str, post_urls: list,
              post_tokens: list) -> SwarmResult:
    """Run a single swarm agent through its full lifecycle."""
    result = SwarmResult(
        agent_num=config.agent_num,
        mode=config.mode,
        success=False,
    )

    try:
        api_key = config.team_api_key or config.api_key
        if not api_key:
            # Solo mode: register, login, get API key
            log.info("[agent-%d] Registering as %s...", config.agent_num, config.email)
            register_agent(config.api_base, config.email, config.password)
            jwt = login_agent(config.api_base, config.email, config.password)
            user_id = get_user_id(config.api_base, jwt)

            if admin_jwt:
                admin_assign_plan(config.api_base, admin_jwt, user_id,
                                  os.environ.get("SWARM_AGENT_PLAN", "swarm-mixed"))
                credit = safe_int(os.environ.get("SWARM_AGENT_CREDIT", "500"), 500, 1, 100000)
                admin_credit_wallet(config.api_base, admin_jwt, user_id=user_id,
                                    amount_cents=credit,
                                    reason=f"AI swarm agent #{config.agent_num}")

            api_key = create_api_key(config.api_base, jwt, f"ai-{config.mode}-{config.agent_num}")
            if not api_key:
                raise RuntimeError("Failed to create API key")
            # Only log 4 chars of API key (8 chars reveals full dn_live_ prefix)
            log.info("[agent-%d] Ready (key: %s...)", config.agent_num, api_key[:4])

        # Run cycles
        for cycle in range(1, config.cycles + 1):
            log.info("[agent-%d] Cycle %d/%d", config.agent_num, cycle, config.cycles)

            # Ask AI what to do (or use simple logic as fallback)
            try:
                action = ai_decide_action(config.agent_num, cycle, config.cycles, "active")
            except Exception:
                action = "post" if cycle == config.cycles else "scrape"

            if action == "scrape" or action == "check":
                # Residential scrapes
                for _ in range(config.res_scrapes):
                    target = random.choice(RES_TARGETS)
                    r = do_proxy_request(target, api_key, config.proxy_host,
                                         config.proxy_port, "residential-country-US")
                    result.res_requests += 1
                    result.res_bytes += r.get("bytes", 0)
                    log.info("[agent-%d]   [res] %s -> %d (%dB)",
                             config.agent_num, target[:50], r["status"], r.get("bytes", 0))
                    time.sleep(config.delay_sec)

                # DC requests
                for _ in range(config.dc_requests):
                    target = random.choice(DC_TARGETS)
                    r = do_proxy_request(target, api_key, config.proxy_host,
                                         config.proxy_port, "dc-country-US")
                    result.dc_requests += 1
                    result.dc_bytes += r.get("bytes", 0)
                    log.info("[agent-%d]   [dc]  %s -> %d (%dB)",
                             config.agent_num, target[:50], r["status"], r.get("bytes", 0))
                    time.sleep(config.delay_sec)

            if action == "post" or cycle == config.cycles:
                # Generate AI post
                stats = {
                    "res_requests": result.res_requests,
                    "dc_requests": result.dc_requests,
                    "total_kb": (result.res_bytes + result.dc_bytes) // 1024,
                    "cycles": cycle,
                }
                post_text = ai_generate_post(config.agent_num, config.mode, stats)
                result.ai_post = post_text
                log.info("[agent-%d]   AI post: %s", config.agent_num, post_text[:100])

                # Post to configured endpoints
                if post_urls:
                    for i, post_url in enumerate(post_urls):
                        if not post_url:
                            continue
                        token = post_tokens[i] if i < len(post_tokens) else ""
                        try:
                            post_body = {"content": post_text, "visibility": "public"}
                            proxy_url = f"http://dc-country-US:{api_key}@{config.proxy_host}:{config.proxy_port}"
                            headers = {"Content-Type": "application/json"}
                            if token:
                                headers["Authorization"] = f"Bearer {token}"
                            resp = requests.post(
                                post_url, json=post_body, headers=headers,
                                proxies={"http": proxy_url, "https": proxy_url},
                                timeout=30,
                            )
                            result.posts_made += 1
                            log.info("[agent-%d]   [post] %s -> %d",
                                     config.agent_num, post_url[:50], resp.status_code)
                        except Exception as e:
                            log.warning("[agent-%d]   [post] failed: %s",
                                        config.agent_num, str(e)[:100])

        result.success = True
        log.info("[agent-%d] Complete: %d res + %d dc requests, %d posts",
                 config.agent_num, result.res_requests, result.dc_requests, result.posts_made)

    except Exception as e:
        # Scrub credentials from error output
        result.error = scrub_credentials(str(e))[:200]
        log.error("[agent-%d] Failed: %s", config.agent_num, result.error)

    return result


# --- Team Orchestrator -------------------------------------------------------

def run_team_swarm(num_agents: int, api_base: str, proxy_host: str, proxy_port: int,
                   admin_jwt: str, password: str, post_urls: list, post_tokens: list,
                   log_dir: str) -> list:
    """Create a team and run agents with team API keys."""
    log.info("=== Team Swarm: %d agents ===", num_agents)

    # Register team owner
    owner_email = "ai-swarm-owner@dominusnode.bot"
    register_agent(api_base, owner_email, password)
    owner_jwt = login_agent(api_base, owner_email, password)
    owner_id = get_user_id(api_base, owner_jwt)

    if admin_jwt:
        admin_assign_plan(api_base, admin_jwt, owner_id, "swarm-mixed")

    # Create team
    team_id = create_team(api_base, owner_jwt, "AI Agent Swarm", num_agents + 10)
    if not team_id:
        raise RuntimeError("Failed to create team")
    log.info("Team created: %s", team_id)

    # Credit team wallet
    credit = safe_int(os.environ.get("SWARM_TEAM_CREDIT", "10000"), 10000, 1, 1000000)
    if admin_jwt:
        admin_credit_wallet(api_base, admin_jwt, team_id=team_id,
                            amount_cents=credit, reason="AI swarm team credit")
        log.info("Team wallet credited: $%.2f", credit / 100)

    # Create team API keys
    keys = []
    for i in range(1, num_agents + 1):
        key = create_team_key(api_base, owner_jwt, team_id, f"ai-team-{i}")
        if key:
            keys.append(key)
        if i % 10 == 0:
            time.sleep(1)  # Rate limit protection
    log.info("Created %d/%d team API keys", len(keys), num_agents)

    if not keys:
        raise RuntimeError("No team API keys created")

    # Build agent configs
    # Use safe_int for all env var parsing
    # Read SWARM_RES_SCRAPES and SWARM_DC_REQUESTS from env
    configs = []
    cycles = safe_int(os.environ.get("SWARM_CYCLES", "5"), 5, 1, 100)
    delay = safe_int(os.environ.get("SWARM_DELAY_SEC", "5"), 5, 1, 300)
    res_scrapes = safe_int(os.environ.get("SWARM_RES_SCRAPES", "1"), 1, 0, 50)
    dc_requests_per = safe_int(os.environ.get("SWARM_DC_REQUESTS", "4"), 4, 0, 50)
    for i, key in enumerate(keys):
        configs.append(AgentConfig(
            agent_num=i + 1,
            email="",  # Not needed for team mode
            password="",
            api_base=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
            mode="team",
            team_api_key=key,
            cycles=cycles,
            delay_sec=delay,
            res_scrapes=res_scrapes,
            dc_requests=dc_requests_per,
        ))

    # Run agents in parallel (batches of 25)
    batch_size = safe_int(os.environ.get("SWARM_BATCH_SIZE", "25"), 25, 1, 100)
    results = []
    for batch_start in range(0, len(configs), batch_size):
        batch = configs[batch_start:batch_start + batch_size]
        log.info("Launching team batch %d-%d...", batch_start + 1, batch_start + len(batch))
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = {
                pool.submit(run_agent, cfg, admin_jwt, post_urls, post_tokens): cfg
                for cfg in batch
            }
            for future in as_completed(futures):
                results.append(future.result())
        if batch_start + batch_size < len(configs):
            delay_between = safe_int(os.environ.get("SWARM_BATCH_DELAY", "10"), 10, 1, 300)
            log.info("Batch complete, waiting %ds...", delay_between)
            time.sleep(delay_between)

    return results


# --- Solo Orchestrator -------------------------------------------------------

def run_solo_swarm(num_agents: int, api_base: str, proxy_host: str, proxy_port: int,
                   admin_jwt: str, password: str, post_urls: list, post_tokens: list,
                   log_dir: str) -> list:
    """Run solo agents, each with their own account."""
    log.info("=== Solo Swarm: %d agents ===", num_agents)

    # Use safe_int for all env var parsing
    # Read SWARM_RES_SCRAPES and SWARM_DC_REQUESTS from env
    configs = []
    cycles = safe_int(os.environ.get("SWARM_CYCLES", "5"), 5, 1, 100)
    delay = safe_int(os.environ.get("SWARM_DELAY_SEC", "5"), 5, 1, 300)
    res_scrapes = safe_int(os.environ.get("SWARM_RES_SCRAPES", "1"), 1, 0, 50)
    dc_requests_per = safe_int(os.environ.get("SWARM_DC_REQUESTS", "4"), 4, 0, 50)
    for i in range(1, num_agents + 1):
        configs.append(AgentConfig(
            agent_num=i,
            email=f"ai-solo-{i}@dominusnode.bot",
            password=password,
            api_base=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
            mode="solo",
            cycles=cycles,
            delay_sec=delay,
            res_scrapes=res_scrapes,
            dc_requests=dc_requests_per,
        ))

    batch_size = safe_int(os.environ.get("SWARM_BATCH_SIZE", "25"), 25, 1, 100)
    results = []
    for batch_start in range(0, len(configs), batch_size):
        batch = configs[batch_start:batch_start + batch_size]
        log.info("Launching solo batch %d-%d...", batch_start + 1, batch_start + len(batch))
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = {
                pool.submit(run_agent, cfg, admin_jwt, post_urls, post_tokens): cfg
                for cfg in batch
            }
            for future in as_completed(futures):
                results.append(future.result())
        if batch_start + batch_size < len(configs):
            delay_between = safe_int(os.environ.get("SWARM_BATCH_DELAY", "10"), 10, 1, 300)
            log.info("Batch complete, waiting %ds...", delay_between)
            time.sleep(delay_between)

    return results


# --- Main --------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="DomiNode AI Swarm Orchestrator")
    parser.add_argument("--num-agents", type=int, required=True)
    parser.add_argument("--mode", choices=["team", "solo", "both"], default="both")
    parser.add_argument("--api-base", default="http://localhost:3000")
    parser.add_argument("--proxy-host", default="localhost")
    parser.add_argument("--proxy-port", type=int, default=8080)
    parser.add_argument("--log-dir", default="/tmp/dominusnode-ai-swarm")
    args = parser.parse_args()

    Path(args.log_dir).mkdir(parents=True, exist_ok=True)

    # Generate shared password for all swarm agents.
    # NOTE: Using a shared password is intentional for ephemeral test/demo
    # accounts. These are bot accounts (@dominusnode.bot) created for swarm testing only.
    # A unique random password is generated per swarm run if SWARM_PASSWORD is not set.
    password = os.environ.get("SWARM_PASSWORD", secrets.token_hex(16))

    # Post configuration
    post_urls = [u.strip() for u in os.environ.get("SWARM_POST_URLS", "").split(",") if u.strip()]
    post_tokens = [t.strip() for t in os.environ.get("SWARM_POST_TOKENS", "").split(",") if t.strip()]

    # Admin login
    admin_jwt = ""
    try:
        admin_jwt = admin_login(args.api_base)
        log.info("Admin authenticated")
    except Exception as e:
        log.warning("Admin login failed: %s. Agents will use default plans.", e)

    # Calculate split
    if args.mode == "team":
        team_count = args.num_agents
        solo_count = 0
    elif args.mode == "solo":
        team_count = 0
        solo_count = args.num_agents
    else:
        team_count = args.num_agents * 70 // 100
        solo_count = args.num_agents - team_count
        if team_count < 1 and args.num_agents >= 1:
            team_count = 1
            solo_count = args.num_agents - 1
        if solo_count < 1 and args.num_agents >= 2:
            solo_count = 1
            team_count = args.num_agents - 1

    log.info("Agent split: %d team + %d solo = %d total", team_count, solo_count, args.num_agents)

    all_results = []

    # Run team swarm
    if team_count > 0:
        try:
            team_results = run_team_swarm(
                team_count, args.api_base, args.proxy_host, args.proxy_port,
                admin_jwt, password, post_urls, post_tokens, args.log_dir,
            )
            all_results.extend(team_results)
        except Exception as e:
            log.error("Team swarm failed: %s", e)

    # Run solo swarm
    if solo_count > 0:
        try:
            solo_results = run_solo_swarm(
                solo_count, args.api_base, args.proxy_host, args.proxy_port,
                admin_jwt, password, post_urls, post_tokens, args.log_dir,
            )
            all_results.extend(solo_results)
        except Exception as e:
            log.error("Solo swarm failed: %s", e)

    # Summary
    succeeded = sum(1 for r in all_results if r.success)
    failed = sum(1 for r in all_results if not r.success)
    total_res = sum(r.res_requests for r in all_results)
    total_dc = sum(r.dc_requests for r in all_results)
    total_res_kb = sum(r.res_bytes for r in all_results) // 1024
    total_dc_kb = sum(r.dc_bytes for r in all_results) // 1024
    total_posts = sum(r.posts_made for r in all_results)

    # Collect AI-generated posts
    ai_posts = [r.ai_post for r in all_results if r.ai_post]

    print()
    print("=" * 50)
    print("  AI Swarm Summary")
    print("=" * 50)
    print(f"  Total agents:   {len(all_results)}")
    print(f"  Succeeded:      {succeeded}")
    print(f"  Failed:         {failed}")
    print(f"  Residential:    {total_res} reqs ({total_res_kb} KB)")
    print(f"  Datacenter:     {total_dc} reqs ({total_dc_kb} KB)")
    print(f"  Total BW:       {total_res_kb + total_dc_kb} KB")
    print(f"  Posts made:     {total_posts}")
    print(f"  AI posts gen:   {len(ai_posts)}")
    print("=" * 50)

    # Save results
    results_file = Path(args.log_dir) / "results.json"
    with open(results_file, "w") as f:
        json.dump({
            "summary": {
                "total": len(all_results),
                "succeeded": succeeded,
                "failed": failed,
                "total_res_requests": total_res,
                "total_dc_requests": total_dc,
                "total_res_kb": total_res_kb,
                "total_dc_kb": total_dc_kb,
                "total_posts": total_posts,
            },
            "ai_posts": ai_posts,
            "agents": [
                {
                    "num": r.agent_num,
                    "mode": r.mode,
                    "success": r.success,
                    "res_requests": r.res_requests,
                    "dc_requests": r.dc_requests,
                    "posts": r.posts_made,
                    "error": r.error,
                }
                for r in all_results
            ],
        }, f, indent=2)
    print(f"  Results saved:  {results_file}")
    print()

    # Print sample AI posts
    if ai_posts:
        print("Sample AI-generated posts:")
        for post in ai_posts[:3]:
            print(f"  > {post}")
        print()

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
