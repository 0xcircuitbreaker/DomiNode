"""Agent Zero adapter tests: generated tools/prompts match the 19 tools and delegate to the SDK."""

from __future__ import annotations

import asyncio
import importlib.util
import json
from unittest.mock import MagicMock

import pytest

from dominusnode_agent_zero import runtime
from dominusnode_agent_zero._core import DominusNodeTools
from dominusnode_agent_zero.generate import PROMPTS_DIR, TOOLS_DIR, render_all

from .test_core import KEY, STANDARD

NAMES = ["dominusnode_" + n for n in STANDARD]


def _tool(name: str):
    spec = importlib.util.spec_from_file_location(f"a0_{name}", TOOLS_DIR / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    cls = [v for v in vars(mod).values() if isinstance(v, type) and v.__module__ == mod.__name__][0]
    return cls(agent=None, name=name, method=None, args={}, message="")


@pytest.fixture()
def client():
    c = MagicMock()
    runtime.set_tools(DominusNodeTools(api_key=KEY, client=c))
    yield c
    runtime.set_tools(None)


def test_tool_files_are_exactly_the_19() -> None:
    assert sorted(p.stem for p in TOOLS_DIR.glob("*.py")) == sorted(NAMES)
    prompts = sorted(p.name for p in PROMPTS_DIR.glob("agent.system.tool.*.md"))
    assert prompts == sorted(f"agent.system.tool.{n}.md" for n in NAMES)


def test_generated_files_are_current() -> None:
    for path, text in render_all().items():
        assert path.read_text() == text, f"{path.name} is stale: run python -m dominusnode_agent_zero.generate"


def test_prompts_never_ask_for_key() -> None:
    for p in PROMPTS_DIR.glob("*.md"):
        text = p.read_text()
        assert "dn_live_" not in text and "api_key" not in text


def test_index_includes_every_tool() -> None:
    idx = (PROMPTS_DIR / "agent.system.tools.dominusnode.md").read_text()
    for n in NAMES:
        assert f"agent.system.tool.{n}.md" in idx


def test_tool_execute_calls_sdk(client: MagicMock) -> None:
    client.network.pricing.return_value = {"residential": {"musdPerGb": "1"}}
    resp = asyncio.run(_tool("dominusnode_network_pricing").execute())
    assert resp.break_loop is False
    assert json.loads(resp.message) == {"residential": {"musdPerGb": "1"}}
    client.network.pricing.assert_called_once_with()


def test_tool_execute_passes_args(client: MagicMock) -> None:
    client.sessions.report.return_value = {"reportId": "r"}
    sid = "123e4567-e89b-12d3-a456-426614174000"
    asyncio.run(_tool("dominusnode_report_session").execute(session_id=sid, reason="blocked"))
    client.sessions.report.assert_called_once_with(sid, "blocked")


def test_tool_errors_scrubbed(client: MagicMock) -> None:
    client.wallet.get_balance.side_effect = RuntimeError(f"oops {KEY}")
    resp = asyncio.run(_tool("dominusnode_balance").execute())
    assert KEY not in resp.message and "error" in json.loads(resp.message)
