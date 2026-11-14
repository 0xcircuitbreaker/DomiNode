"""Documentation-only TypedDicts for the main results (wire keys are camelCase, as the server sends them)."""

from __future__ import annotations

from typing import Dict, List, Optional

try:
    from typing import TypedDict
except ImportError:  # pragma: no cover
    from typing_extensions import TypedDict  # type: ignore

from .secret import Secret


class Money(TypedDict):
    musd: str  # integer µUSD
    usd: str  # 6 decimals


class ConnectResult(TypedDict, total=False):
    mfaRequired: bool
    userId: str


class ActiveSession(TypedDict):
    id: str
    startedAt: str
    status: str


class CreatedApiKey(TypedDict):
    id: str
    prefix: str
    label: str
    created_at: str
    key: Secret


class PowChallenge(TypedDict):
    challengeId: str
    prefix: str
    difficulty: int
    algorithm: str
    expiresAt: str


class NodeChallenge(TypedDict):
    nonce: str
    attestationText: str
    attestationVersion: int
    policyVersion: int
    message: str
    expiresAt: str
    powChallenge: PowChallenge


class RegisteredNode(TypedDict):
    nodeId: str
    status: str
    attestationVersion: int
    nodeKey: Secret


class Payout(TypedDict, total=False):
    id: str
    amount: Money
    trigger: str
    status: str  # pending held_tax held_frozen submitted confirmed failed reversed
    txHash: Optional[str]
    createdAt: str
    failureReason: Optional[str]
    address: str
    chain: str
    updatedAt: str


class AgenticWallet(TypedDict):
    id: str
    label: str
    balanceCents: int
    spendingLimitCents: int
    dailyLimitCents: Optional[int]
    allowedDomains: Optional[List[str]]
    status: str
    createdAt: str


class PricingEntry(TypedDict):
    ipClass: str
    pricePerGbMusd: str


class NetworkPricing(TypedDict):
    currency: str
    unit: str
    prices: List[PricingEntry]
    nodeShare: List[Dict[str, object]]
    buyerDiscounts: List["BuyerDiscount"]
    maturationHours: int
    rails: List[str]


class BuyerDiscount(TypedDict):
    tier: str
    rank: int
    buyerDiscountBps: int


class NetworkGroupStats(TypedDict):
    """Online nodes and paid bytes (decimal string) in the last 24h for one operator group."""

    online: int
    paidBytes24h: str


class NetworkStats(TypedDict):
    onlineNodes: int
    byClass: Dict[str, int]
    byCountry: List[Dict[str, object]]
    otherCountries: int
    seed: NetworkGroupStats
    community: NetworkGroupStats
    generatedAt: str


class AgentWalletBalance(TypedDict):
    """GET /v1/wallet (raw API key)."""

    balanceCents: int
    currency: str
    lastToppedUp: Optional[str]


class PublicIncident(TypedDict):
    title: str
    body: str
    severity: str
    status: str
    startedAt: str
    resolvedAt: Optional[str]
    updatedAt: str


class StatusCoordinator(TypedDict):
    status: str  # "operational" | "down"
    policyVersion: Optional[int]


class StatusGateway(TypedDict):
    status: str  # "operational" | "down" | "unknown"
    instancesOnline: int
    lastHeartbeatAt: Optional[str]


class StatusAvailability(TypedDict):
    """Percent of minutes with a live gateway; None before any heartbeat."""

    last24h: Optional[float]
    last7d: Optional[float]


class StatusNodes(TypedDict, total=False):
    onlineNodes: int
    byClass: Dict[str, int]
    byCountry: List[Dict[str, object]]
    otherCountries: int
    countriesAvailable: int
    suppressed: List[str]


class NetworkStatus(TypedDict):
    """GET /v1/status: aggregate public health; no node ids, instance ids or IPs."""

    status: str  # "operational" | "degraded" | "down" | "unknown"
    coordinator: StatusCoordinator
    gateway: StatusGateway
    availability: StatusAvailability
    nodes: Optional[StatusNodes]
    incidents: List[PublicIncident]
    generatedAt: str


class TeamKey(TypedDict):
    id: str
    prefix: str
    keyPrefix: str
    label: str
    userId: str
    teamId: str
    createdAt: str
    revokedAt: Optional[str]


class TeamInvite(TypedDict):
    id: str
    teamId: str
    email: str
    role: str
    invitedBy: str
    expiresAt: str
    createdAt: str


class ProxyHealth(TypedDict):
    status: str
