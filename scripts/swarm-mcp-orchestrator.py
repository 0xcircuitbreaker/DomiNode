#!/usr/bin/env python3
"""Option A: Claude Code MCP Orchestrator for DomiNode Integration Testing.

Spawns Claude Code sub-processes, each with the DomiNode MCP server plugin.
Each agent autonomously registers via PoW, scrapes data through proxy, and reports results.
NO workarounds -- pure MCP tool usage only.

Usage:
    python scripts/swarm-mcp-orchestrator.py
    python scripts/swarm-mcp-orchestrator.py --integrations mcp-basic mcp-residential moltbook --agents 6
    python scripts/swarm-mcp-orchestrator.py --concurrent 2 --timeout 180 --proxy-type residential

Environment:
    API_BASE            API URL (default: https://api.dominusnode.com)
    PROXY_HOST          Proxy hostname (default: proxy.dominusnode.com)
    PROXY_PORT          Proxy port (default: 8080)
    ADMIN_EMAIL         Admin email for crediting agents
    ADMIN_PASSWORD      Admin password
    DOMINUSNODE_AGENT_SECRET   MCP agent secret for CAPTCHA bypass
"""

import argparse
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── ANSI colors ───────────────────────────────────────────────────────────────
C_GRN = "\033[92m"
C_RED = "\033[91m"
C_YLW = "\033[93m"
C_CYN = "\033[96m"
C_MAG = "\033[95m"
C_BLD = "\033[1m"
C_DIM = "\033[2m"
C_RST = "\033[0m"

# Disable colors if not a TTY or on Windows without VT100 support
if not sys.stdout.isatty():
    C_GRN = C_RED = C_YLW = C_CYN = C_MAG = C_BLD = C_DIM = C_RST = ""

REPO_ROOT = Path(__file__).resolve().parent.parent

# ── MCP Server Reference ─────────────────────────────────────────────────────
# The DomiNode MCP server is installed via:
#   claude mcp add dominusnode -- npx -y @dominusnode/mcp-server
# Or for local development:
#   claude mcp add dominusnode -- node <repo>/packages/mcp-server/dist/src/index.js
MCP_NPX_CMD = "npx -y @dominusnode/mcp-server"
MCP_LOCAL_CMD = str(REPO_ROOT / "packages" / "mcp-server" / "dist" / "src" / "index.js")


# ── Data classes ──────────────────────────────────────────────────────────────
@dataclass
class AgentConfig:
    """Configuration for a single Claude Code MCP agent."""
    agent_id: int
    integration: str
    email: str
    password: str
    key_label: str
    proxy_type: str
    target_url: str
    country: str
    work_dir: str
    moltbook_post: bool = False


@dataclass
class AgentResult:
    """Result from a single Claude Code MCP agent run."""
    agent_id: int
    integration: str
    success: bool = False
    setup_ok: bool = False
    balance_ok: bool = False
    proxy_status_ok: bool = False
    fetch_ok: bool = False
    fetch_bytes: int = 0
    account_info_ok: bool = False
    usage_ok: bool = False
    keys_ok: bool = False
    teams_ok: bool = False
    wallets_ok: bool = False
    moltbook_post_ok: bool = False
    duration: float = 0.0
    error: str = ""
    raw_output: str = ""
    parsed_json: Optional[Dict[str, Any]] = None


# ── Integration definitions ───────────────────────────────────────────────────
# Each "integration" is a distinct agent prompt strategy.
# All use the same MCP server -- the variation is in WHAT the agent is told to do.

INTEGRATIONS = {
    "mcp-basic": {
        "name": "MCP Basic Lifecycle",
        "description": "Register, check balance, fetch via proxy, verify account",
        "color": C_CYN,
        "prompt_builder": "_build_basic_prompt",
    },
    "mcp-residential": {
        "name": "MCP Residential Proxy",
        "description": "Register and fetch through residential proxy with geo-targeting",
        "color": C_GRN,
        "prompt_builder": "_build_residential_prompt",
    },
    "mcp-datacenter": {
        "name": "MCP Datacenter Proxy",
        "description": "Register and fetch through datacenter proxy (cheapest)",
        "color": C_YLW,
        "prompt_builder": "_build_datacenter_prompt",
    },
    "mcp-full-lifecycle": {
        "name": "MCP Full Lifecycle",
        "description": "Complete lifecycle: setup, keys, teams, wallets, fetch, usage, cleanup",
        "color": C_MAG,
        "prompt_builder": "_build_full_lifecycle_prompt",
    },
    "mcp-teams": {
        "name": "MCP Teams & Wallets",
        "description": "Register, create team, manage agentic wallets, invite members",
        "color": C_CYN,
        "prompt_builder": "_build_teams_prompt",
    },
    "mcp-multi-fetch": {
        "name": "MCP Multi-Fetch",
        "description": "Register, fetch 3 different URLs through different countries",
        "color": C_GRN,
        "prompt_builder": "_build_multi_fetch_prompt",
    },
    "moltbook": {
        "name": "MCP + Moltbook Post",
        "description": "Register, fetch data, then create a Moltbook post about the experience",
        "color": C_MAG,
        "prompt_builder": "_build_moltbook_prompt",
    },
}


# ── Prompt builders ───────────────────────────────────────────────────────────
# Each returns a prompt string telling the Claude Code agent exactly what to do.
# The agent has ONLY MCP tools -- no SDK, no curl, no direct HTTP.

def _build_json_instructions() -> str:
    """Common JSON output instructions appended to every prompt."""
    return (
        "\n\nCRITICAL: After completing ALL steps, output EXACTLY one JSON object on its own line "
        "with the following structure. Do NOT wrap it in markdown code fences. "
        "Output it as raw JSON:\n"
        '{"setup_ok":true/false,"balance":"$X.XX","proxy_status":"operational/down/unknown",'
        '"fetch_result":"success/error","fetch_bytes":NNN,"account_info":"verified/unverified",'
        '"usage_checked":true/false,"keys_managed":true/false,"teams_managed":true/false,'
        '"wallets_managed":true/false,"moltbook_posted":true/false,'
        '"errors":["any error messages"]}'
    )


def _build_basic_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing the DomiNode proxy service. You have the DomiNode MCP server plugin installed. "
        "Use ONLY the dominusnode_* MCP tools. Do NOT use curl, fetch, or any other HTTP method.\n\n"
        "Follow these steps IN ORDER:\n\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance to check your wallet balance\n"
        "3. Call dominusnode_get_proxy_status to verify the proxy network is operational\n"
        f'4. Call dominusnode_fetch with url "{cfg.target_url}" and pool_type "{cfg.proxy_type}" '
        f'and country "{cfg.country}"\n'
        "5. Call dominusnode_get_account_info to get your account details\n"
        + _build_json_instructions()
    )


def _build_residential_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing DomiNode's RESIDENTIAL proxy network. Use ONLY dominusnode_* MCP tools.\n\n"
        "Follow these steps IN ORDER:\n\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance to verify your wallet\n"
        "3. Call dominusnode_get_proxy_config to see available proxy endpoints and countries\n"
        '4. Call dominusnode_fetch with url "https://httpbin.org/ip" and pool_type "residential" '
        f'and country "{cfg.country}"\n'
        "5. Call dominusnode_get_proxy_status to check latency and session count\n"
        "6. Call dominusnode_get_account_info to confirm email verification status\n"
        f'7. Call dominusnode_fetch with url "{cfg.target_url}" and pool_type "residential" '
        f'and country "{cfg.country}" (second fetch to verify IP rotation)\n'
        + _build_json_instructions()
    )


def _build_datacenter_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing DomiNode's DATACENTER proxy network ($3/GB, fastest). "
        "Use ONLY dominusnode_* MCP tools.\n\n"
        "Follow these steps IN ORDER:\n\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance to verify your wallet\n"
        '3. Call dominusnode_fetch with url "https://httpbin.org/ip" and pool_type "dc" '
        f'and country "{cfg.country}"\n'
        '4. Call dominusnode_fetch with url "https://httpbin.org/headers" and pool_type "dc"\n'
        "5. Call dominusnode_get_usage with days 1 to see bandwidth consumed\n"
        "6. Call dominusnode_get_account_info to verify account state\n"
        + _build_json_instructions()
    )


def _build_full_lifecycle_prompt(cfg: AgentConfig) -> str:
    return (
        "You are running a FULL LIFECYCLE test of the DomiNode proxy service. "
        "Use ONLY dominusnode_* MCP tools. Execute every step.\n\n"
        "SETUP:\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_account_info\n"
        "3. Call dominusnode_get_balance\n\n"
        "PROXY:\n"
        "4. Call dominusnode_get_proxy_status\n"
        "5. Call dominusnode_get_proxy_config\n"
        f'6. Call dominusnode_fetch with url "{cfg.target_url}" and pool_type "{cfg.proxy_type}" '
        f'and country "{cfg.country}"\n\n'
        "USAGE:\n"
        "7. Call dominusnode_get_usage with days 1\n"
        "8. Call dominusnode_get_daily_usage with days 1\n"
        "9. Call dominusnode_get_top_hosts with limit 5 and days 1\n\n"
        "KEYS:\n"
        "10. Call dominusnode_list_keys\n"
        "11. Call dominusnode_create_key with label \"lifecycle-test-key\"\n"
        "    Save the key ID from the response.\n"
        "12. Call dominusnode_revoke_key with the key ID from step 11\n\n"
        "TEAMS:\n"
        "13. Call dominusnode_create_team with name \"lifecycle-test-team\"\n"
        "    Save the team ID from the response.\n"
        "14. Call dominusnode_list_teams\n"
        "15. Call dominusnode_team_details with the team ID\n"
        "16. Call dominusnode_team_delete with the team ID\n\n"
        "WALLETS:\n"
        "17. Call dominusnode_create_agentic_wallet with label \"lifecycle-wallet\" "
        "and spending_limit_cents 10000\n"
        "    Save the wallet ID from the response.\n"
        "18. Call dominusnode_list_agentic_wallets\n"
        "19. Call dominusnode_agentic_wallet_balance with the wallet ID\n"
        "20. Call dominusnode_delete_agentic_wallet with the wallet ID\n\n"
        "BILLING:\n"
        "21. Call dominusnode_get_transactions\n"
        "22. Call dominusnode_get_forecast\n"
        + _build_json_instructions()
    )


def _build_teams_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing DomiNode's TEAM and AGENTIC WALLET features. "
        "Use ONLY dominusnode_* MCP tools.\n\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance\n\n"
        "TEAM MANAGEMENT:\n"
        '3. Call dominusnode_create_team with name "test-team"\n'
        "   Save the team ID.\n"
        "4. Call dominusnode_team_details with the team ID\n"
        '5. Call dominusnode_update_team with the team ID and name "renamed-team"\n'
        "6. Call dominusnode_team_list_members with the team ID\n"
        '7. Call dominusnode_team_create_key with the team ID and label "team-api-key"\n'
        "   Save the key ID.\n"
        "8. Call dominusnode_team_list_keys with the team ID\n"
        "9. Call dominusnode_team_revoke_key with the team ID and key ID\n\n"
        "AGENTIC WALLETS:\n"
        '10. Call dominusnode_create_agentic_wallet with label "agent-wallet" '
        "and spending_limit_cents 5000\n"
        "    Save the wallet ID.\n"
        "11. Call dominusnode_agentic_wallet_balance with the wallet ID\n"
        "12. Call dominusnode_list_agentic_wallets\n"
        "13. Call dominusnode_freeze_agentic_wallet with the wallet ID\n"
        "14. Call dominusnode_unfreeze_agentic_wallet with the wallet ID\n"
        "15. Call dominusnode_delete_agentic_wallet with the wallet ID\n\n"
        "CLEANUP:\n"
        "16. Call dominusnode_team_delete with the team ID\n"
        + _build_json_instructions()
    )


def _build_multi_fetch_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing DomiNode's proxy with MULTIPLE fetch requests across different "
        "countries. Use ONLY dominusnode_* MCP tools.\n\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance\n"
        "3. Call dominusnode_get_proxy_status\n\n"
        "MULTI-COUNTRY FETCH:\n"
        '4. Call dominusnode_fetch with url "https://httpbin.org/ip" and pool_type '
        f'"{cfg.proxy_type}" and country "US"\n'
        '5. Call dominusnode_fetch with url "https://httpbin.org/ip" and pool_type '
        f'"{cfg.proxy_type}" and country "DE"\n'
        '6. Call dominusnode_fetch with url "https://httpbin.org/ip" and pool_type '
        f'"{cfg.proxy_type}" and country "JP"\n\n'
        "VERIFICATION:\n"
        "7. Call dominusnode_get_usage with days 1\n"
        "8. Call dominusnode_get_top_hosts with limit 5 and days 1\n"
        "9. Call dominusnode_get_account_info\n"
        + _build_json_instructions()
    )


def _build_moltbook_prompt(cfg: AgentConfig) -> str:
    return (
        "You are testing DomiNode proxy AND creating a Moltbook social post about the experience. "
        "Use ONLY dominusnode_* MCP tools. You also have Moltbook MCP tools if available.\n\n"
        "DOMINUSNODE SETUP:\n"
        f'1. Call dominusnode_setup with email "{cfg.email}" and password "{cfg.password}" '
        f'and key_label "{cfg.key_label}"\n'
        "2. Call dominusnode_get_balance\n"
        "3. Call dominusnode_get_proxy_status\n"
        f'4. Call dominusnode_fetch with url "{cfg.target_url}" and pool_type "{cfg.proxy_type}" '
        f'and country "{cfg.country}"\n'
        "   Note the IP address returned and the bytes transferred.\n"
        "5. Call dominusnode_get_account_info\n"
        "6. Call dominusnode_get_usage with days 1\n\n"
        "MOLTBOOK POST:\n"
        "7. If you have a moltbook_create_post tool available, call it with a post about "
        "your experience testing DomiNode's proxy. Include:\n"
        "   - The proxy type used and country\n"
        "   - How many bytes were transferred\n"
        "   - That the IP was rotated automatically\n"
        "   - Hashtags: #DominusNode #AIProxy #AgenticInfra\n"
        "   If no moltbook tool is available, set moltbook_posted to false.\n\n"
        "8. Call dominusnode_get_transactions to see the usage charge\n"
        + _build_json_instructions()
    )


# Map prompt builder names to functions
_PROMPT_BUILDERS = {
    "_build_basic_prompt": _build_basic_prompt,
    "_build_residential_prompt": _build_residential_prompt,
    "_build_datacenter_prompt": _build_datacenter_prompt,
    "_build_full_lifecycle_prompt": _build_full_lifecycle_prompt,
    "_build_teams_prompt": _build_teams_prompt,
    "_build_multi_fetch_prompt": _build_multi_fetch_prompt,
    "_build_moltbook_prompt": _build_moltbook_prompt,
}


# ── Credential scrubbing ─────────────────────────────────────────────────────

def scrub(msg: str) -> str:
    """Remove sensitive credentials from log output."""
    msg = re.sub(r'dn_(live|test)_[a-zA-Z0-9_-]+', 'dn_***', msg)
    msg = re.sub(r'"password"\s*:\s*"[^"]*"', '"password":"***"', msg)
    msg = re.sub(r'eyJ[a-zA-Z0-9_-]{10,}', 'JWT_REDACTED', msg)
    msg = re.sub(r'das_[a-zA-Z0-9_-]+', 'das_***', msg)
    return msg


# ── Claude Code subprocess management ────────────────────────────────────────

def check_claude_cli() -> bool:
    """Verify that the Claude Code CLI is available."""
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def setup_mcp_plugin(work_dir: str, use_local: bool = False) -> bool:
    """Install the DomiNode MCP server plugin in the agent's working directory.

    Uses `claude mcp add` to register the MCP server for the agent's scope.
    Returns True on success.
    """
    if use_local:
        # Use local built MCP server (for development)
        local_entry = MCP_LOCAL_CMD
        if not Path(local_entry).exists():
            print(f"  {C_YLW}Warning: Local MCP server not built at {local_entry}{C_RST}")
            print(f"  {C_DIM}Run 'npm run build' first, or omit --local-mcp{C_RST}")
            return False
        cmd = ["claude", "mcp", "add", "dominusnode", "--scope", "project", "--", "node", local_entry]
    else:
        # Use published package via npx
        cmd = ["claude", "mcp", "add", "dominusnode", "--scope", "project", "--", "npx", "-y", "@dominusnode/mcp-server"]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=30,
            cwd=work_dir,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  {C_RED}MCP plugin install failed: {e}{C_RST}")
        return False


def run_claude_agent(
    agent_cfg: AgentConfig,
    prompt: str,
    timeout_sec: int = 120,
    use_local_mcp: bool = False,
) -> AgentResult:
    """Spawn a Claude Code subprocess with MCP tools and collect results.

    The agent runs in non-interactive mode (claude -p) with the DomiNode MCP
    server plugin providing all tools.
    """
    result = AgentResult(
        agent_id=agent_cfg.agent_id,
        integration=agent_cfg.integration,
    )
    t0 = time.time()

    try:
        # Ensure work directory exists
        os.makedirs(agent_cfg.work_dir, exist_ok=True)

        # Create a .claude directory in the work dir so project scope works
        claude_dir = os.path.join(agent_cfg.work_dir, ".claude")
        os.makedirs(claude_dir, exist_ok=True)

        # Install MCP plugin
        if not setup_mcp_plugin(agent_cfg.work_dir, use_local=use_local_mcp):
            result.error = "Failed to install MCP plugin"
            result.duration = time.time() - t0
            return result

        # Build environment for the subprocess
        env = os.environ.copy()
        # The MCP server reads these env vars for configuration
        env["DOMINUSNODE_API_URL"] = env.get("API_BASE", "https://api.dominusnode.com")
        env["DOMINUSNODE_PROXY_HOST"] = env.get("PROXY_HOST", "proxy.dominusnode.com")
        env["DOMINUSNODE_HTTP_PROXY_PORT"] = env.get("PROXY_PORT", "8080")
        # Do NOT set DOMINUSNODE_API_KEY -- we want bootstrap mode so the agent
        # can use dominusnode_setup to register autonomously
        env.pop("DOMINUSNODE_API_KEY", None)
        # Pass agent secret if available (enables CAPTCHA bypass + email auto-verify)
        agent_secret = env.get("DOMINUSNODE_AGENT_SECRET", "")
        if agent_secret:
            env["DOMINUSNODE_MCP_AGENT_SECRET"] = agent_secret

        # Run Claude in print mode (non-interactive)
        # --print / -p outputs the response and exits
        cmd = [
            "claude",
            "-p",                       # print mode (non-interactive)
            "--output-format", "text",  # plain text output
            prompt,
        ]

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            cwd=agent_cfg.work_dir,
            env=env,
        )

        result.raw_output = proc.stdout or ""
        stderr_output = proc.stderr or ""

        if proc.returncode != 0:
            result.error = f"Claude exited with code {proc.returncode}: {scrub(stderr_output[:500])}"
            result.duration = time.time() - t0
            return result

        # Parse the agent's output to extract the JSON result
        _parse_agent_output(result, result.raw_output)

    except subprocess.TimeoutExpired:
        result.error = f"Agent timed out after {timeout_sec}s"
    except FileNotFoundError:
        result.error = "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
    except Exception as e:
        result.error = f"Agent error: {scrub(str(e))[:300]}"

    result.duration = time.time() - t0
    return result


def _parse_agent_output(result: AgentResult, output: str) -> None:
    """Parse the Claude agent's output to extract structured results.

    Looks for a JSON object in the output matching our expected schema.
    Falls back to heuristic parsing if no valid JSON found.
    """
    # Try to find a JSON object in the output
    json_match = None

    # Strategy 1: Look for a line that starts with { and ends with }
    for line in output.split("\n"):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                parsed = json.loads(line)
                if "setup_ok" in parsed or "fetch_result" in parsed:
                    json_match = parsed
                    break
            except json.JSONDecodeError:
                continue

    # Strategy 2: Try to extract JSON from markdown code blocks
    if json_match is None:
        code_block_pattern = re.compile(r'```(?:json)?\s*\n({[^`]+})\s*\n```', re.DOTALL)
        for match in code_block_pattern.finditer(output):
            try:
                parsed = json.loads(match.group(1))
                if "setup_ok" in parsed or "fetch_result" in parsed:
                    json_match = parsed
                    break
            except json.JSONDecodeError:
                continue

    # Strategy 3: Find any JSON-like object in the output
    if json_match is None:
        brace_pattern = re.compile(r'\{[^{}]*"setup_ok"[^{}]*\}', re.DOTALL)
        for match in brace_pattern.finditer(output):
            try:
                parsed = json.loads(match.group(0))
                json_match = parsed
                break
            except json.JSONDecodeError:
                continue

    if json_match:
        result.parsed_json = json_match
        result.setup_ok = json_match.get("setup_ok", False) is True
        result.balance_ok = bool(json_match.get("balance"))
        result.proxy_status_ok = json_match.get("proxy_status", "").lower() in (
            "operational", "ok", "healthy", "online",
        )
        result.fetch_ok = json_match.get("fetch_result", "").lower() in ("success", "ok")
        result.fetch_bytes = int(json_match.get("fetch_bytes", 0) or 0)
        result.account_info_ok = json_match.get("account_info", "").lower() in (
            "verified", "ok", "active",
        )
        result.usage_ok = json_match.get("usage_checked", False) is True
        result.keys_ok = json_match.get("keys_managed", False) is True
        result.teams_ok = json_match.get("teams_managed", False) is True
        result.wallets_ok = json_match.get("wallets_managed", False) is True
        result.moltbook_post_ok = json_match.get("moltbook_posted", False) is True
        errors = json_match.get("errors", [])
        if errors:
            result.error = "; ".join(str(e) for e in errors)
        # Determine overall success
        result.success = result.setup_ok and (result.fetch_ok or result.balance_ok)
    else:
        # Heuristic parsing: look for key phrases in the output
        output_lower = output.lower()
        result.setup_ok = "account created" in output_lower or "setup complete" in output_lower
        result.balance_ok = "balance:" in output_lower or "$" in output_lower
        result.proxy_status_ok = "operational" in output_lower or "status: ok" in output_lower
        result.fetch_ok = "status: 200" in output_lower or "httpbin" in output_lower
        result.account_info_ok = "email:" in output_lower or "user id:" in output_lower
        result.success = result.setup_ok and result.fetch_ok
        if not result.success:
            result.error = "Could not parse structured JSON from agent output"

        # Try to extract fetch bytes from output
        bytes_match = re.search(r'bytes:\s*(\d+)', output, re.IGNORECASE)
        if bytes_match:
            result.fetch_bytes = int(bytes_match.group(1))


# ── Agent orchestration ───────────────────────────────────────────────────────

def make_agent_email(integration: str, agent_id: int) -> str:
    """Generate a unique email for an agent. Uses .bot domain."""
    nonce = secrets.token_hex(4)
    return f"mcp-{integration}-{agent_id}-{nonce}@dominusnode.bot"


def make_agent_password() -> str:
    """Generate a secure random password for an agent."""
    return secrets.token_hex(16)


def create_agent_configs(
    integrations: List[str],
    agents_per_integration: int,
    proxy_type: str,
    target_url: str,
    country: str,
    base_tmp_dir: str,
) -> List[AgentConfig]:
    """Create AgentConfig instances for all agents."""
    configs = []
    agent_id = 1

    for integration in integrations:
        if integration not in INTEGRATIONS:
            print(f"  {C_YLW}Warning: Unknown integration '{integration}', skipping{C_RST}")
            continue

        for _ in range(agents_per_integration):
            work_dir = os.path.join(base_tmp_dir, f"agent-{agent_id}-{integration}")
            configs.append(AgentConfig(
                agent_id=agent_id,
                integration=integration,
                email=make_agent_email(integration, agent_id),
                password=make_agent_password(),
                key_label=f"mcp-agent-{agent_id}",
                proxy_type=proxy_type,
                target_url=target_url,
                country=country,
                work_dir=work_dir,
                moltbook_post=(integration == "moltbook"),
            ))
            agent_id += 1

    return configs


def run_single_agent(
    agent_cfg: AgentConfig,
    timeout_sec: int,
    use_local_mcp: bool,
) -> AgentResult:
    """Run a single agent and return results. Called by the thread pool."""
    info = INTEGRATIONS[agent_cfg.integration]
    builder_name = info["prompt_builder"]
    builder_fn = _PROMPT_BUILDERS[builder_name]
    prompt = builder_fn(agent_cfg)

    return run_claude_agent(
        agent_cfg=agent_cfg,
        prompt=prompt,
        timeout_sec=timeout_sec,
        use_local_mcp=use_local_mcp,
    )


# ── Admin helpers (optional: credit agents for testing) ───────────────────────

def admin_credit_agent(
    api_base: str,
    admin_email: str,
    admin_password: str,
    target_email: str,
    credit_cents: int = 200,
) -> bool:
    """Use admin API to credit an agent's wallet. Requires requests library.

    This is OPTIONAL -- agents can use the free tier (10 connections, 1GB).
    Only needed for heavier testing.
    """
    try:
        import requests as req
    except ImportError:
        return False

    agent_secret = os.environ.get("DOMINUSNODE_AGENT_SECRET", "")
    headers = {"Content-Type": "application/json"}
    if agent_secret:
        headers["X-DominusNode-Agent"] = "mcp"
        headers["X-DominusNode-Agent-Secret"] = agent_secret

    try:
        # Admin login
        login_resp = req.post(
            f"{api_base}/api/auth/login",
            json={"email": admin_email, "password": admin_password},
            headers=headers,
            timeout=15,
        )
        if login_resp.status_code != 200:
            return False
        admin_jwt = login_resp.json().get("token", "")
        if not admin_jwt:
            return False

        headers["Authorization"] = f"Bearer {admin_jwt}"

        # Find user by email (not directly possible via API, so skip crediting)
        # The admin credit requires user ID, which we don't have until after registration.
        # Agents should use free tier or the admin can credit after.
        return False
    except Exception:
        return False


# ── Output formatting ─────────────────────────────────────────────────────────

def format_status_line(result: AgentResult) -> str:
    """Format a single agent's result as a status line."""
    info = INTEGRATIONS.get(result.integration, {"name": result.integration, "color": C_RST})
    color = info["color"]
    name = info["name"]

    if result.success:
        status = f"{C_GRN}PASS{C_RST}"
    elif result.error:
        status = f"{C_RED}FAIL{C_RST}"
    else:
        status = f"{C_YLW}WARN{C_RST}"

    checks = []
    checks.append(f"setup:{'Y' if result.setup_ok else 'N'}")
    checks.append(f"bal:{'Y' if result.balance_ok else 'N'}")
    checks.append(f"fetch:{'Y' if result.fetch_ok else 'N'}")
    if result.fetch_bytes > 0:
        checks.append(f"{result.fetch_bytes}B")
    checks.append(f"acct:{'Y' if result.account_info_ok else 'N'}")
    if result.keys_ok:
        checks.append("keys:Y")
    if result.teams_ok:
        checks.append("teams:Y")
    if result.wallets_ok:
        checks.append("wallets:Y")
    if result.moltbook_post_ok:
        checks.append("moltbook:Y")

    checks_str = " ".join(checks)
    error_str = f"  {C_DIM}{scrub(result.error[:60])}{C_RST}" if result.error and not result.success else ""

    return (
        f"  {color}[{name}]{C_RST} Agent #{result.agent_id:02d}  "
        f"[{status}]  {checks_str}  ({result.duration:.1f}s){error_str}"
    )


def print_summary_table(results: List[AgentResult]) -> None:
    """Print a summary table of all agent results."""
    print(f"\n{C_CYN}{'=' * 78}{C_RST}")
    print(f"{C_BLD}  MCP Orchestrator Results{C_RST}")
    print(f"{C_CYN}{'-' * 78}{C_RST}")

    total = len(results)
    passed = sum(1 for r in results if r.success)
    failed = total - passed

    print(f"  Total: {total}  {C_GRN}Passed: {passed}{C_RST}  {C_RED}Failed: {failed}{C_RST}")
    print(f"{C_CYN}{'-' * 78}{C_RST}")

    # Group by integration
    by_integration: Dict[str, List[AgentResult]] = {}
    for r in results:
        by_integration.setdefault(r.integration, []).append(r)

    # Header
    print(f"  {'Integration':<24} {'Pass':>4} {'Fail':>4} {'Setup':>5} "
          f"{'Bal':>3} {'Fetch':>5} {'Acct':>4} {'Keys':>4} {'Teams':>5} "
          f"{'Wallet':>6} {'Avg(s)':>6}")
    print(f"  {'-' * 74}")

    for integration, agent_results in sorted(by_integration.items()):
        info = INTEGRATIONS.get(integration, {"name": integration, "color": C_RST})
        name = info["name"][:24]
        color = info["color"]

        n_pass = sum(1 for r in agent_results if r.success)
        n_fail = len(agent_results) - n_pass
        n_setup = sum(1 for r in agent_results if r.setup_ok)
        n_bal = sum(1 for r in agent_results if r.balance_ok)
        n_fetch = sum(1 for r in agent_results if r.fetch_ok)
        n_acct = sum(1 for r in agent_results if r.account_info_ok)
        n_keys = sum(1 for r in agent_results if r.keys_ok)
        n_teams = sum(1 for r in agent_results if r.teams_ok)
        n_wallets = sum(1 for r in agent_results if r.wallets_ok)
        avg_dur = sum(r.duration for r in agent_results) / len(agent_results)

        pass_color = C_GRN if n_pass == len(agent_results) else (C_YLW if n_pass > 0 else C_RED)

        print(
            f"  {color}{name:<24}{C_RST} "
            f"{pass_color}{n_pass:>4}{C_RST} {n_fail:>4} "
            f"{n_setup:>5} {n_bal:>3} {n_fetch:>5} {n_acct:>4} "
            f"{n_keys:>4} {n_teams:>5} {n_wallets:>6} {avg_dur:>6.1f}"
        )

    print(f"{C_CYN}{'-' * 78}{C_RST}")

    # Errors summary
    errors = [(r.agent_id, r.integration, r.error) for r in results if r.error and not r.success]
    if errors:
        print(f"\n  {C_RED}{C_BLD}Errors:{C_RST}")
        for aid, integ, err in errors:
            print(f"    Agent #{aid:02d} ({integ}): {scrub(err[:100])}")

    print(f"{C_CYN}{'=' * 78}{C_RST}")


def save_results(results: List[AgentResult], config: Dict[str, Any], output_file: str) -> None:
    """Save results to a JSON file."""
    output_dir = os.path.dirname(output_file)
    if output_dir:
        os.makedirs(output_dir, mode=0o700, exist_ok=True)

    data = {
        "orchestrator": "swarm-mcp-orchestrator",
        "version": "1.0.0",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "config": config,
        "summary": {
            "total": len(results),
            "passed": sum(1 for r in results if r.success),
            "failed": sum(1 for r in results if not r.success),
            "avg_duration_sec": (
                sum(r.duration for r in results) / len(results) if results else 0
            ),
        },
        "results": [
            {
                "agent_id": r.agent_id,
                "integration": r.integration,
                "success": r.success,
                "setup_ok": r.setup_ok,
                "balance_ok": r.balance_ok,
                "proxy_status_ok": r.proxy_status_ok,
                "fetch_ok": r.fetch_ok,
                "fetch_bytes": r.fetch_bytes,
                "account_info_ok": r.account_info_ok,
                "usage_ok": r.usage_ok,
                "keys_ok": r.keys_ok,
                "teams_ok": r.teams_ok,
                "wallets_ok": r.wallets_ok,
                "moltbook_post_ok": r.moltbook_post_ok,
                "duration": round(r.duration, 2),
                "error": scrub(r.error) if r.error else "",
                "parsed_json": r.parsed_json,
            }
            for r in results
        ],
    }

    # Use os.open for secure file creation (mode 0o600)
    fd = os.open(output_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)


# ── Main orchestrator ─────────────────────────────────────────────────────────

def run_orchestrator(args: argparse.Namespace) -> int:
    """Main orchestrator entry point. Returns exit code."""

    print(f"\n{C_CYN}{'=' * 78}{C_RST}")
    print(f"{C_BLD}  DomiNode MCP Orchestrator (Option A){C_RST}")
    print(f"{C_DIM}  Claude Code sub-processes with MCP server plugin{C_RST}")
    print(f"{C_CYN}{'=' * 78}{C_RST}\n")

    # Validate Claude CLI
    print(f"  Checking Claude CLI...", end="", flush=True)
    if not check_claude_cli():
        print(f"  {C_RED}NOT FOUND{C_RST}")
        print(f"\n  {C_RED}Claude Code CLI is required.{C_RST}")
        print(f"  Install: npm install -g @anthropic-ai/claude-code")
        print(f"  Docs: https://docs.anthropic.com/en/docs/claude-code\n")
        return 1
    print(f"  {C_GRN}OK{C_RST}")

    # Parse integration list
    integrations = args.integrations
    if not integrations:
        integrations = ["mcp-basic", "mcp-residential", "mcp-full-lifecycle"]

    # Validate integrations
    valid_integrations = []
    for integ in integrations:
        if integ in INTEGRATIONS:
            valid_integrations.append(integ)
        else:
            print(f"  {C_YLW}Unknown integration '{integ}'. Available: {', '.join(INTEGRATIONS.keys())}{C_RST}")
    if not valid_integrations:
        print(f"\n  {C_RED}No valid integrations selected.{C_RST}")
        print(f"  Available: {', '.join(INTEGRATIONS.keys())}")
        return 1

    # Configuration
    api_base = os.environ.get("API_BASE", args.api_base)
    proxy_host = os.environ.get("PROXY_HOST", args.proxy_host)
    proxy_port = os.environ.get("PROXY_PORT", str(args.proxy_port))
    agents_per = args.agents_per_integration
    concurrent = min(args.concurrent, len(valid_integrations) * agents_per)
    timeout_sec = args.timeout

    config = {
        "api_base": api_base,
        "proxy_host": proxy_host,
        "proxy_port": proxy_port,
        "integrations": valid_integrations,
        "agents_per_integration": agents_per,
        "concurrent": concurrent,
        "timeout_sec": timeout_sec,
        "proxy_type": args.proxy_type,
        "target_url": args.target_url,
        "country": args.country,
        "use_local_mcp": args.local_mcp,
    }

    # Print config
    total_agents = len(valid_integrations) * agents_per
    print(f"\n  Integrations:  {len(valid_integrations)} selected")
    for integ in valid_integrations:
        info = INTEGRATIONS[integ]
        print(f"    {info['color']}{info['name']:<28}{C_RST} {info['description']}")
    print(f"  Agents:        {total_agents} total ({agents_per} per integration)")
    print(f"  Concurrent:    {concurrent}")
    print(f"  Timeout:       {timeout_sec}s per agent")
    print(f"  Proxy type:    {args.proxy_type}")
    print(f"  Target URL:    {args.target_url}")
    print(f"  Country:       {args.country}")
    print(f"  API base:      {api_base}")
    print(f"  MCP server:    {'local' if args.local_mcp else 'npx (published)'}")
    print()

    # Create temp directory for agent work dirs
    base_tmp_dir = tempfile.mkdtemp(prefix="dominusnode-mcp-")
    print(f"  {C_DIM}Work directory: {base_tmp_dir}{C_RST}")

    # Create agent configs
    agent_configs = create_agent_configs(
        integrations=valid_integrations,
        agents_per_integration=agents_per,
        proxy_type=args.proxy_type,
        target_url=args.target_url,
        country=args.country,
        base_tmp_dir=base_tmp_dir,
    )

    if not agent_configs:
        print(f"\n  {C_RED}No agents to launch.{C_RST}")
        return 1

    # Launch agents
    print(f"\n  {C_BLD}Launching {len(agent_configs)} Claude Code agents...{C_RST}\n")

    results: List[AgentResult] = []
    done_count = 0

    with ThreadPoolExecutor(max_workers=concurrent) as pool:
        future_to_cfg = {
            pool.submit(
                run_single_agent,
                cfg,
                timeout_sec,
                args.local_mcp,
            ): cfg
            for cfg in agent_configs
        }

        for future in as_completed(future_to_cfg):
            cfg = future_to_cfg[future]
            done_count += 1
            try:
                result = future.result()
                results.append(result)
                status_line = format_status_line(result)
                print(f"  [{done_count}/{len(agent_configs)}] {status_line}")
            except Exception as e:
                error_result = AgentResult(
                    agent_id=cfg.agent_id,
                    integration=cfg.integration,
                    error=f"Thread error: {scrub(str(e))[:200]}",
                )
                results.append(error_result)
                print(f"  [{done_count}/{len(agent_configs)}] "
                      f"{C_RED}Agent #{cfg.agent_id} ({cfg.integration}) CRASHED: "
                      f"{scrub(str(e))[:60]}{C_RST}")

    # Sort results by agent_id for consistent output
    results.sort(key=lambda r: r.agent_id)

    # Print summary
    print_summary_table(results)

    # Save results
    output_file = args.output
    if not output_file:
        results_dir = os.path.join(tempfile.gettempdir(), "dominusnode-mcp-results")
        os.makedirs(results_dir, mode=0o700, exist_ok=True)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        output_file = os.path.join(results_dir, f"mcp-orchestrator-{timestamp}.json")

    save_results(results, config, output_file)
    print(f"\n  {C_DIM}Results saved: {output_file}{C_RST}")

    # Cleanup temp dirs (leave them for debugging if --keep-workdirs)
    if not args.keep_workdirs:
        import shutil
        try:
            shutil.rmtree(base_tmp_dir, ignore_errors=True)
            print(f"  {C_DIM}Cleaned up work directories{C_RST}")
        except Exception:
            pass
    else:
        print(f"  {C_DIM}Work directories preserved: {base_tmp_dir}{C_RST}")

    print()

    # Return exit code based on results
    passed = sum(1 for r in results if r.success)
    return 0 if passed == len(results) else 1


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="DomiNode MCP Orchestrator -- Claude Code sub-processes with MCP tools",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Available integrations:
  mcp-basic           Register + balance + fetch + verify (simple test)
  mcp-residential     Residential proxy with geo-targeting
  mcp-datacenter      Datacenter proxy (cheapest, $3/GB)
  mcp-full-lifecycle  Full lifecycle: setup, keys, teams, wallets, fetch, usage
  mcp-teams           Team management + agentic wallets
  mcp-multi-fetch     Multi-country fetch comparison
  moltbook            Proxy test + Moltbook social post

Examples:
  python scripts/swarm-mcp-orchestrator.py
  python scripts/swarm-mcp-orchestrator.py --integrations mcp-basic mcp-residential --agents 2
  python scripts/swarm-mcp-orchestrator.py --integrations mcp-full-lifecycle --concurrent 1 --timeout 180
  python scripts/swarm-mcp-orchestrator.py --integrations moltbook --proxy-type residential --country US
        """,
    )
    parser.add_argument(
        "--integrations", nargs="+", default=[],
        help="Integration IDs to test (default: mcp-basic mcp-residential mcp-full-lifecycle)",
    )
    parser.add_argument(
        "--agents", dest="agents_per_integration", type=int, default=1,
        help="Number of agents PER integration (default: 1)",
    )
    parser.add_argument(
        "--concurrent", type=int, default=4,
        help="Max concurrent agents (default: 4)",
    )
    parser.add_argument(
        "--timeout", type=int, default=120,
        help="Timeout per agent in seconds (default: 120)",
    )
    parser.add_argument(
        "--proxy-type", default="dc", choices=["dc", "residential", "auto"],
        help="Proxy pool type (default: dc)",
    )
    parser.add_argument(
        "--target-url", default="https://httpbin.org/ip",
        help="URL to fetch through proxy (default: https://httpbin.org/ip)",
    )
    parser.add_argument(
        "--country", default="US",
        help="2-letter country code for geo-targeting (default: US)",
    )
    parser.add_argument(
        "--api-base", default="https://api.dominusnode.com",
        help="DomiNode API base URL",
    )
    parser.add_argument(
        "--proxy-host", default="proxy.dominusnode.com",
        help="Proxy gateway hostname",
    )
    parser.add_argument(
        "--proxy-port", type=int, default=8080,
        help="Proxy gateway port",
    )
    parser.add_argument(
        "--output", default="",
        help="Output JSON file path (default: auto-generated in temp dir)",
    )
    parser.add_argument(
        "--local-mcp", action="store_true",
        help="Use locally built MCP server instead of npx published package",
    )
    parser.add_argument(
        "--keep-workdirs", action="store_true",
        help="Keep agent work directories for debugging",
    )
    parser.add_argument(
        "--list-integrations", action="store_true",
        help="List available integrations and exit",
    )

    args = parser.parse_args()

    # List integrations
    if args.list_integrations:
        print(f"\n{C_BLD}Available MCP Integrations:{C_RST}\n")
        for key, info in INTEGRATIONS.items():
            print(f"  {info['color']}{key:<24}{C_RST} {info['description']}")
        print()
        return 0

    return run_orchestrator(args)


if __name__ == "__main__":
    sys.exit(main())
