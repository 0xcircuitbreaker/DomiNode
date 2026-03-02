#!/usr/bin/env python3
"""
Dominus Node Integration Swarm Tester

Tests each AI integration (LangChain, CrewAI, LlamaIndex, AutoGPT, Agent Zero, etc.)
by creating agents that USE the actual plugins to interact with Dominus Node, then generate
social posts about the experience to attract real AI agent users.

Architecture:
  1. Admin credits a test wallet for each integration
  2. Each integration gets its own agent that:
     a. Authenticates via the plugin's native method
     b. Checks balance using the plugin's balance tool
     c. Makes proxy requests using the plugin's fetch tool
     d. Checks usage stats
     e. Uses the local AI model to generate a social post about the experience
  3. Posts are collected and saved to results JSON

Usage:
  python3 ai-swarm-integration-test.py --api-base http://localhost:3000

  # Test specific integrations:
  python3 ai-swarm-integration-test.py --integrations langchain crewai autogpt

  # All available integrations:
  python3 ai-swarm-integration-test.py --integrations all
"""

import argparse
import importlib
import json
import logging
import os
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    print("ERROR: 'requests' package required. pip install requests")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("integration-test")

AI_API_BASE = os.environ.get("AI_API_BASE", "http://localhost:11434/v1")
AI_MODEL = os.environ.get("AI_MODEL", "qwen3:8b")


def safe_int(value: str, default: int, min_val: int = 0, max_val: int = 100000) -> int:
    try:
        n = int(value)
        return max(min_val, min(n, max_val))
    except (ValueError, TypeError):
        return default


def scrub_credentials(msg: str) -> str:
    msg = re.sub(r'dn_(live|test)_[a-zA-Z0-9]+', 'dn_***', msg)
    msg = re.sub(r'"password"\s*:\s*"[^"]*"', '"password":"***"', msg)
    return msg


# --- AI Generation -----------------------------------------------------------

def ai_generate(prompt: str, max_tokens: int = 512, temperature: float = 0.7) -> str:
    """Generate text using local AI model via OpenAI-compatible API."""
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
        return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log.warning("AI generation failed: %s", e)
        return ""


# --- Dominus Node API Helpers ----------------------------------------------------

def api_request(method: str, url: str, jwt: str = "", json_data: dict = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    try:
        resp = requests.request(method, url, headers=headers, json=json_data, timeout=30)
        return {"status": resp.status_code, "body": resp.json() if resp.text else {}}
    except Exception as e:
        return {"status": 0, "body": {"error": scrub_credentials(str(e))}}


def admin_login(api_base: str) -> str:
    email = os.environ.get("ADMIN_EMAIL", "")
    password = os.environ.get("ADMIN_PASSWORD", "")
    resp = api_request("POST", f"{api_base}/api/auth/login", json_data={
        "email": email, "password": password,
    })
    if resp["status"] != 200 or "token" not in resp["body"]:
        raise RuntimeError(f"Admin login failed (status {resp['status']})")
    return resp["body"]["token"]


def setup_test_account(api_base: str, admin_jwt: str, email: str, password: str,
                       credit_cents: int = 1000) -> dict:
    """Register an account, assign plan, credit wallet, create API key."""
    # Register
    api_request("POST", f"{api_base}/api/auth/register", json_data={
        "email": email, "password": password,
    })

    # Login
    login_resp = api_request("POST", f"{api_base}/api/auth/login", json_data={
        "email": email, "password": password,
    })
    jwt = login_resp["body"].get("token", "")
    if not jwt:
        raise RuntimeError(f"Login failed for {email}")

    # Get user ID
    me_resp = api_request("GET", f"{api_base}/api/auth/me", jwt=jwt)
    user = me_resp["body"].get("user", me_resp["body"])
    user_id = user.get("id", "")

    # Admin: assign plan + credit
    if admin_jwt and user_id:
        api_request("PUT", f"{api_base}/api/admin/users/{user_id}/plan",
                    jwt=admin_jwt, json_data={"planId": "swarm-mixed"})
        api_request("POST", f"{api_base}/api/admin/credit-wallet",
                    jwt=admin_jwt, json_data={
                        "targetUserId": user_id,
                        "amountCents": credit_cents,
                        "reason": f"Integration test: {email}",
                    })

    # Create API key
    key_resp = api_request("POST", f"{api_base}/api/keys", jwt=jwt,
                           json_data={"label": f"integration-test"})
    raw_key = key_resp["body"].get("rawKey", key_resp["body"].get("key", ""))

    return {"jwt": jwt, "user_id": user_id, "api_key": raw_key}


# --- Integration Test Definitions --------------------------------------------

@dataclass
class IntegrationTestResult:
    name: str
    success: bool = False
    balance_check: bool = False
    proxy_fetch: bool = False
    usage_check: bool = False
    fetch_bytes: int = 0
    fetch_status: int = 0
    ai_post: str = ""
    error: str = ""
    duration_sec: float = 0.0


# Each integration test function takes (api_key, api_base, proxy_host, proxy_port)
# and returns a dict of results from using the ACTUAL plugin tools.

def test_langchain(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test LangChain integration using DominusNodeToolkit."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        from dominusnode_langchain import DominusNodeToolkit
        toolkit = DominusNodeToolkit(
            api_key=api_key,
            base_url=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
        )
        tools = toolkit.get_tools()
        tool_map = {t.name: t for t in tools}

        # Check balance
        if "dominusnode_check_balance" in tool_map:
            results["balance"] = tool_map["dominusnode_check_balance"].run("")
        elif "dominusnode_balance" in tool_map:
            results["balance"] = tool_map["dominusnode_balance"].run("")

        # Proxied fetch
        for name in ("dominusnode_proxied_fetch", "dominusnode_proxy_fetch"):
            if name in tool_map:
                results["fetch"] = tool_map[name].run(json.dumps({
                    "url": "https://httpbin.org/ip",
                    "country": "US",
                    "proxy_type": "dc",
                }))
                break

        # Usage
        for name in ("dominusnode_check_usage", "dominusnode_usage"):
            if name in tool_map:
                results["usage"] = tool_map[name].run("")
                break

    except ImportError:
        results["error"] = "dominusnode-langchain not installed"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_crewai(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test CrewAI integration using DominusNode tool classes."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        from dominusnode_crewai.tools import (
            DominusNodeBalanceTool,
            DominusNodeWebScrapeTool,
        )

        balance_tool = DominusNodeBalanceTool(api_key=api_key)
        results["balance"] = balance_tool._run()

        scrape_tool = DominusNodeWebScrapeTool(api_key=api_key)
        results["fetch"] = scrape_tool._run(
            url="https://httpbin.org/ip",
            country="US",
            proxy_type="dc",
        )

    except ImportError:
        results["error"] = "dominusnode-crewai not installed"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_llamaindex(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test LlamaIndex integration using DominusNodeToolSpec."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        from dominusnode_llamaindex import DominusNodeToolSpec
        spec = DominusNodeToolSpec(
            api_key=api_key,
            base_url=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
        )

        results["balance"] = spec.check_balance()
        results["fetch"] = spec.proxied_fetch(
            url="https://httpbin.org/ip",
            country="US",
            proxy_type="dc",
        )
        results["usage"] = spec.check_usage()

    except ImportError:
        results["error"] = "dominusnode-llamaindex not installed"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_autogpt(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test AutoGPT integration using DominusNodePlugin."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        from dominusnode_autogpt import DominusNodePlugin
        plugin = DominusNodePlugin(
            api_key=api_key,
            base_url=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
        )

        results["balance"] = plugin.check_balance()
        results["fetch"] = plugin.handle_command("proxied_fetch", {
            "url": "https://httpbin.org/ip",
            "country": "US",
            "proxy_type": "dc",
        })
        results["usage"] = plugin.handle_command("check_usage", {})

    except ImportError:
        results["error"] = "dominusnode-autogpt not installed"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_agent_zero(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test Agent Zero integration using tool modules."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        # Agent Zero uses a different import structure
        agent_zero_path = Path(__file__).parent.parent / "integrations" / "agent-zero"
        if str(agent_zero_path) not in sys.path:
            sys.path.insert(0, str(agent_zero_path))

        from shared.auth import DominusNodeAuth
        from tools.proxy_fetch import TOOLS as proxy_tools
        from tools.wallet import TOOLS as wallet_tools

        auth = DominusNodeAuth(
            api_key=api_key,
            base_url=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
        )

        if "check_balance" in wallet_tools:
            results["balance"] = wallet_tools["check_balance"](auth, {})

        if "proxied_fetch" in proxy_tools:
            results["fetch"] = proxy_tools["proxied_fetch"](auth, {
                "url": "https://httpbin.org/ip",
                "country": "US",
                "proxy_type": "dc",
            })

    except ImportError:
        results["error"] = "agent-zero integration not loadable"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_pydantic_ai(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Test Pydantic AI integration."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        from dominusnode_pydanticai.tools import DominusNodeTools
        tools = DominusNodeTools(
            api_key=api_key,
            base_url=api_base,
            proxy_host=proxy_host,
            proxy_port=proxy_port,
        )

        results["balance"] = tools.check_balance()
        results["fetch"] = tools.proxied_fetch(
            url="https://httpbin.org/ip",
            country="US",
            proxy_type="dc",
        )

    except ImportError:
        results["error"] = "dominusnode-pydanticai not installed"
    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


def test_raw_http(api_key: str, api_base: str, proxy_host: str, proxy_port: int) -> dict:
    """Fallback: test using raw HTTP calls (no integration package needed)."""
    results = {"balance": None, "fetch": None, "usage": None}
    try:
        # Verify key → get JWT
        verify_resp = api_request("POST", f"{api_base}/api/auth/verify-key",
                                  json_data={"apiKey": api_key})
        jwt = verify_resp["body"].get("token", "")
        if not jwt:
            results["error"] = "API key verification failed"
            return results

        # Check balance
        bal_resp = api_request("GET", f"{api_base}/api/wallet", jwt=jwt)
        results["balance"] = json.dumps(bal_resp["body"])

        # Proxied fetch via HTTP proxy
        proxy_url = f"http://dc-country-US:{api_key}@{proxy_host}:{proxy_port}"
        try:
            resp = requests.get(
                "https://httpbin.org/ip",
                proxies={"http": proxy_url, "https": proxy_url},
                timeout=30,
                headers={"User-Agent": "DominusNode-IntegrationTest/1.0"},
            )
            results["fetch"] = json.dumps({
                "status": resp.status_code,
                "bytes": len(resp.content),
                "body": resp.text[:500],
            })
        except Exception as e:
            results["fetch"] = json.dumps({"error": scrub_credentials(str(e))[:200]})

        # Usage
        usage_resp = api_request("GET", f"{api_base}/api/usage", jwt=jwt)
        results["usage"] = json.dumps(usage_resp["body"])

    except Exception as e:
        results["error"] = scrub_credentials(str(e))[:200]
    return results


# Registry of testable integrations
INTEGRATION_TESTS = {
    "langchain": {
        "func": test_langchain,
        "package": "dominusnode-langchain",
        "description": "LangChain toolkit with DominusNodeToolkit",
        "framework": "LangChain",
    },
    "crewai": {
        "func": test_crewai,
        "package": "dominusnode-crewai",
        "description": "CrewAI tools (WebScrape, Balance, GeoTarget)",
        "framework": "CrewAI",
    },
    "llamaindex": {
        "func": test_llamaindex,
        "package": "dominusnode-llamaindex",
        "description": "LlamaIndex DominusNodeToolSpec with 22 functions",
        "framework": "LlamaIndex",
    },
    "autogpt": {
        "func": test_autogpt,
        "package": "dominusnode-autogpt",
        "description": "AutoGPT command plugin (23 commands)",
        "framework": "AutoGPT",
    },
    "agent-zero": {
        "func": test_agent_zero,
        "package": "(built-in, no pip install)",
        "description": "Agent Zero numbered tool modules",
        "framework": "Agent Zero",
    },
    "pydantic-ai": {
        "func": test_pydantic_ai,
        "package": "dominusnode-pydanticai",
        "description": "Pydantic AI tool definitions",
        "framework": "Pydantic AI",
    },
    "raw-http": {
        "func": test_raw_http,
        "package": "(none — uses requests directly)",
        "description": "Direct HTTP + proxy gateway (no framework)",
        "framework": "Raw HTTP",
    },
}


# --- Main Test Runner --------------------------------------------------------

def run_integration_test(
    integration_name: str,
    api_key: str,
    api_base: str,
    proxy_host: str,
    proxy_port: int,
) -> IntegrationTestResult:
    """Run a single integration test and generate an AI post about it."""
    result = IntegrationTestResult(name=integration_name)
    start = time.time()

    test_info = INTEGRATION_TESTS[integration_name]
    log.info("[%s] Testing %s...", integration_name, test_info["description"])

    try:
        test_results = test_info["func"](api_key, api_base, proxy_host, proxy_port)

        if test_results.get("error"):
            result.error = test_results["error"]
            log.warning("[%s] Error: %s", integration_name, result.error)
        else:
            # Evaluate results
            if test_results.get("balance"):
                result.balance_check = True
                log.info("[%s]   Balance: OK", integration_name)

            if test_results.get("fetch"):
                result.proxy_fetch = True
                fetch_data = test_results["fetch"]
                if isinstance(fetch_data, str):
                    try:
                        parsed = json.loads(fetch_data)
                        result.fetch_status = parsed.get("status", 0)
                        result.fetch_bytes = parsed.get("bytes", len(fetch_data))
                    except (json.JSONDecodeError, TypeError):
                        result.fetch_bytes = len(fetch_data)
                log.info("[%s]   Fetch: OK (%d bytes)", integration_name, result.fetch_bytes)

            if test_results.get("usage"):
                result.usage_check = True
                log.info("[%s]   Usage: OK", integration_name)

            result.success = result.balance_check or result.proxy_fetch

    except Exception as e:
        result.error = scrub_credentials(str(e))[:200]
        log.error("[%s] Failed: %s", integration_name, result.error)

    result.duration_sec = round(time.time() - start, 2)

    # Generate AI post about this integration test
    framework = test_info["framework"]
    features_tested = []
    if result.balance_check:
        features_tested.append("wallet balance check")
    if result.proxy_fetch:
        features_tested.append(f"proxied fetch ({result.fetch_bytes}B)")
    if result.usage_check:
        features_tested.append("usage stats")

    prompt = f"""You are an AI agent that just tested the Dominus Node proxy service using the {framework} integration.

Here's what happened:
- Integration: {framework} ({test_info['description']})
- Features tested: {', '.join(features_tested) if features_tested else 'setup only'}
- Success: {'Yes' if result.success else 'No'}
- Duration: {result.duration_sec}s
- Error: {result.error or 'None'}

Write a short social media post (under 280 characters) about your experience using Dominus Node's
{framework} integration. Focus on:
- How easy it was to use Dominus Node through {framework}
- The proxy routing (DC + residential) and geo-targeting
- SDKs for Node.js, Python, Rust, Go, Java, C++
- That it just works with existing {framework} agents

Be enthusiastic but authentic. Include #DominusNode and #{framework.replace(' ', '')}."""

    post = ai_generate(prompt, max_tokens=150, temperature=0.8)
    if not post:
        # Template fallback
        if result.success:
            post = (
                f"Tested Dominus Node's {framework} integration — "
                f"{', '.join(features_tested)}. "
                f"Rotating proxies with geo-targeting, {result.duration_sec}s total. "
                f"Works seamlessly with existing {framework} agents. "
                f"#DominusNode #{framework.replace(' ', '')}"
            )
        else:
            post = (
                f"Setting up Dominus Node's {framework} integration. "
                f"22 tools for proxy, wallet, teams, agentic wallets. "
                f"SDKs: Node/Python/Rust/Go/Java/C++. #DominusNode #{framework.replace(' ', '')}"
            )
    result.ai_post = post[:280]

    log.info("[%s] Post: %s", integration_name, result.ai_post[:100])
    return result


def main():
    parser = argparse.ArgumentParser(description="Dominus Node Integration Swarm Tester")
    parser.add_argument("--api-base", default="http://localhost:3000")
    parser.add_argument("--proxy-host", default="localhost")
    parser.add_argument("--proxy-port", type=int, default=8080)
    parser.add_argument("--log-dir", default="")
    parser.add_argument(
        "--integrations", nargs="+", default=["all"],
        help="Which integrations to test (or 'all')",
    )
    parser.add_argument(
        "--credit-cents", type=int, default=1000,
        help="Wallet credit per integration test account (default: 1000 = $10)",
    )
    args = parser.parse_args()

    log_dir = args.log_dir or os.path.join(
        os.environ.get("TEMP", "/tmp"), "dominusnode-integration-test"
    )
    Path(log_dir).mkdir(parents=True, exist_ok=True)

    # Determine which integrations to test
    if "all" in args.integrations:
        test_names = list(INTEGRATION_TESTS.keys())
    else:
        test_names = [n for n in args.integrations if n in INTEGRATION_TESTS]
        unknown = [n for n in args.integrations if n not in INTEGRATION_TESTS]
        if unknown:
            log.warning("Unknown integrations: %s", unknown)
            log.info("Available: %s", list(INTEGRATION_TESTS.keys()))

    if not test_names:
        log.error("No valid integrations to test")
        return 1

    print()
    print("=" * 55)
    print("  Dominus Node Integration Swarm Tester")
    print("=" * 55)
    print(f"  Integrations: {', '.join(test_names)}")
    print(f"  API:          {args.api_base}")
    print(f"  Proxy:        {args.proxy_host}:{args.proxy_port}")
    print(f"  Credit:       ${args.credit_cents / 100:.2f} per test")
    print()

    # Admin login
    admin_jwt = ""
    try:
        admin_jwt = admin_login(args.api_base)
        log.info("Admin authenticated")
    except Exception as e:
        log.warning("Admin login failed: %s", e)

    # Generate shared password for test accounts
    password = secrets.token_hex(16)

    # Run each integration test
    all_results: List[IntegrationTestResult] = []

    for name in test_names:
        info = INTEGRATION_TESTS[name]
        email = f"integration-test-{name}@dominusnode.bot"

        log.info("=" * 50)
        log.info("Testing: %s (%s)", name, info["framework"])
        log.info("=" * 50)

        try:
            # Setup test account
            account = setup_test_account(
                args.api_base, admin_jwt, email, password,
                credit_cents=args.credit_cents,
            )
            api_key = account["api_key"]
            if not api_key:
                log.error("[%s] Failed to create API key", name)
                result = IntegrationTestResult(name=name, error="No API key")
                all_results.append(result)
                continue

            # Run integration test
            result = run_integration_test(
                name, api_key, args.api_base, args.proxy_host, args.proxy_port,
            )
            all_results.append(result)

        except Exception as e:
            log.error("[%s] Setup failed: %s", name, scrub_credentials(str(e))[:200])
            all_results.append(IntegrationTestResult(
                name=name, error=scrub_credentials(str(e))[:200],
            ))

        time.sleep(2)  # Brief pause between tests

    # Summary
    succeeded = sum(1 for r in all_results if r.success)
    failed = sum(1 for r in all_results if not r.success)
    posts = [r.ai_post for r in all_results if r.ai_post]

    print()
    print("=" * 55)
    print("  Integration Test Results")
    print("=" * 55)
    print()

    for r in all_results:
        status = "PASS" if r.success else ("SKIP" if "not installed" in (r.error or "") else "FAIL")
        icon = {"PASS": "+", "SKIP": "-", "FAIL": "X"}[status]
        features = []
        if r.balance_check:
            features.append("balance")
        if r.proxy_fetch:
            features.append("proxy")
        if r.usage_check:
            features.append("usage")

        print(f"  [{icon}] {r.name:<15} {status:<5} "
              f"{'  '.join(features) if features else r.error or 'no features tested'} "
              f"({r.duration_sec}s)")

    print()
    print(f"  Total:     {len(all_results)}")
    print(f"  Passed:    {succeeded}")
    print(f"  Failed:    {failed}")
    print(f"  Posts:     {len(posts)}")
    print("=" * 55)

    # Save results
    results_file = Path(log_dir) / "integration-results.json"
    with open(results_file, "w") as f:
        json.dump({
            "summary": {
                "total": len(all_results),
                "passed": succeeded,
                "failed": failed,
                "posts_generated": len(posts),
            },
            "integrations": [
                {
                    "name": r.name,
                    "success": r.success,
                    "balance_check": r.balance_check,
                    "proxy_fetch": r.proxy_fetch,
                    "usage_check": r.usage_check,
                    "fetch_bytes": r.fetch_bytes,
                    "duration_sec": r.duration_sec,
                    "error": r.error,
                    "ai_post": r.ai_post,
                }
                for r in all_results
            ],
            "posts": posts,
        }, f, indent=2)
    print(f"  Results: {results_file}")

    # Print sample posts
    if posts:
        print()
        print("Generated Social Posts:")
        for i, post in enumerate(posts[:5]):
            print(f"  [{i+1}] {post}")
        print()

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
