"""Mock crewai and dominusnode modules before any test imports."""
import sys
from typing import Any, Optional
from unittest.mock import MagicMock

from pydantic import BaseModel, ConfigDict


# ── Flexible mock type ──────────────────────────────────────────────────

class _FlexType:
    """Base that accepts any keyword arguments."""

    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


class ProxyUrlOptions(_FlexType):
    pass


# ── Mock dominusnode SDK ────────────────────────────────────────────────

dominusnode_mock = MagicMock()
dominusnode_types_mock = MagicMock()
dominusnode_types_mock.ProxyUrlOptions = ProxyUrlOptions
dominusnode_mock.DominusNodeClient = MagicMock
dominusnode_mock.types = dominusnode_types_mock

sys.modules.setdefault("dominusnode", dominusnode_mock)
sys.modules.setdefault("dominusnode.types", dominusnode_types_mock)


# ── Mock crewai ─────────────────────────────────────────────────────────

crewai_mock = MagicMock()
crewai_tools_mock = MagicMock()


class BaseTool(BaseModel):
    """Mock crewai BaseTool using Pydantic BaseModel (like real CrewAI)."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str = ""
    description: str = ""

    def _run(self, **kwargs: Any) -> str:
        raise NotImplementedError


crewai_tools_mock.BaseTool = BaseTool
crewai_mock.tools = crewai_tools_mock
crewai_mock.Agent = MagicMock
crewai_mock.Task = MagicMock
crewai_mock.Crew = MagicMock

sys.modules.setdefault("crewai", crewai_mock)
sys.modules.setdefault("crewai.tools", crewai_tools_mock)
