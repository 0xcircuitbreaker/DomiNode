"""Dominus Node SDK type definitions.

Uses TypedDict for JSON-compatible response types. These match the shapes
returned by the Dominus Node REST API.
"""

from __future__ import annotations

from typing import Any, List, Optional
from dataclasses import dataclass, field


# ──────────────────────────────────────────────────────────────────────
# Auth
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class User:
    id: str
    email: str
    created_at: str
    is_admin: bool = False


@dataclass(frozen=True, repr=False)
class LoginResult:
    """Result from login or register. May require MFA."""

    user: Optional[User] = None
    token: Optional[str] = None
    refresh_token: Optional[str] = None
    mfa_required: bool = False
    mfa_challenge_token: Optional[str] = None

    def __repr__(self) -> str:
        return f"LoginResult(user={self.user!r}, mfa_required={self.mfa_required}, token={'[REDACTED]' if self.token else None}, refresh_token={'[REDACTED]' if self.refresh_token else None})"


@dataclass(frozen=True)
class MfaStatus:
    enabled: bool
    backup_codes_remaining: int = 0


@dataclass(frozen=True, repr=False)
class MfaSetup:
    secret: str
    otpauth_uri: str
    backup_codes: List[str] = field(default_factory=list)

    def __repr__(self) -> str:
        return f"MfaSetup(secret='[REDACTED]', otpauth_uri='[REDACTED]', backup_codes=[{len(self.backup_codes)} codes])"


# ──────────────────────────────────────────────────────────────────────
# API Keys
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ApiKey:
    id: str
    prefix: str
    label: str
    created_at: str
    revoked_at: Optional[str] = None


@dataclass(frozen=True, repr=False)
class CreatedApiKey:
    """Returned only on creation -- includes the raw key (shown once)."""

    key: str
    id: str
    prefix: str
    label: str
    created_at: str

    def __repr__(self) -> str:
        return f"CreatedApiKey(id={self.id!r}, prefix={self.prefix!r}, label={self.label!r}, key='[REDACTED]')"


# ──────────────────────────────────────────────────────────────────────
# Wallet
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Wallet:
    balance_cents: int
    balance_usd: float
    currency: str
    last_topped_up: Optional[str] = None


@dataclass(frozen=True)
class WalletTransaction:
    id: str
    type: str
    amount_cents: int
    amount_usd: float
    description: str
    payment_provider: Optional[str] = None
    created_at: str = ""


@dataclass(frozen=True)
class WalletForecast:
    daily_avg_cents: int
    days_remaining: Optional[float]
    trend: str  # "up" | "down" | "stable"
    trend_pct: int


@dataclass(frozen=True)
class StripeCheckout:
    session_id: str
    url: str


@dataclass(frozen=True)
class CryptoInvoice:
    invoice_id: str
    invoice_url: str
    pay_currency: str
    price_amount: float


@dataclass(frozen=True)
class PaypalOrder:
    order_id: str
    approval_url: str
    amount_cents: int


# ──────────────────────────────────────────────────────────────────────
# Usage
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class UsageSummary:
    total_bytes: int
    total_cost_cents: int
    request_count: int
    total_gb: float
    total_cost_usd: float


@dataclass(frozen=True)
class UsageRecord:
    id: str
    session_id: str
    bytes_in: int
    bytes_out: int
    total_bytes: int
    cost_cents: int
    proxy_type: str
    target_host: str
    created_at: str


@dataclass(frozen=True)
class UsagePagination:
    limit: int
    offset: int
    total: int


@dataclass(frozen=True)
class UsagePeriod:
    since: str
    until: str


@dataclass(frozen=True)
class UsageResponse:
    summary: UsageSummary
    records: List[UsageRecord]
    pagination: UsagePagination
    period: UsagePeriod


@dataclass(frozen=True)
class DailyUsage:
    date: str
    total_bytes: int
    total_gb: float
    total_cost_cents: int
    total_cost_usd: float
    request_count: int


@dataclass(frozen=True)
class TopHost:
    target_host: str
    total_bytes: int
    total_gb: float
    request_count: int


# ──────────────────────────────────────────────────────────────────────
# Plans
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    price_per_gb_cents: int
    price_per_gb_usd: float
    monthly_bandwidth_bytes: int
    monthly_bandwidth_gb: Optional[float]
    is_default: bool


@dataclass(frozen=True)
class UserPlanUsage:
    monthly_usage_bytes: int
    monthly_usage_gb: float
    limit_bytes: int
    limit_gb: Optional[float]
    percent_used: Optional[float]


@dataclass(frozen=True)
class UserPlanInfo:
    plan: Plan
    usage: UserPlanUsage


# ──────────────────────────────────────────────────────────────────────
# Sessions
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ActiveSession:
    id: str
    started_at: str
    status: str


# ──────────────────────────────────────────────────────────────────────
# Proxy
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProxyUrlOptions:
    """Options for building a proxy URL."""

    country: Optional[str] = None
    state: Optional[str] = None
    city: Optional[str] = None
    asn: Optional[int] = None  # R14 H-1: ASN targeting (API parity with Node.js/C++/Rust)
    session_id: Optional[str] = None
    protocol: str = "http"  # "http" or "socks5"


@dataclass(frozen=True)
class ProxyHealth:
    status: str
    active_sessions: int
    uptime_seconds: int


@dataclass(frozen=True)
class ProviderStat:
    name: str
    state: str
    consecutive_failures: int
    total_requests: int
    total_errors: int
    avg_latency_ms: float
    fallback_only: bool


@dataclass(frozen=True)
class ProxyEndpoints:
    http: str
    socks5: str


@dataclass(frozen=True)
class ProxyStatus:
    status: str
    active_sessions: int
    user_active_sessions: int
    avg_latency_ms: float
    providers: List[ProviderStat]
    endpoints: ProxyEndpoints
    supported_countries: List[str]
    uptime_seconds: int


@dataclass(frozen=True)
class GeoTargeting:
    state_support: bool
    city_support: bool
    asn_support: bool
    us_states: List[Any] = field(default_factory=list)
    major_us_cities: List[Any] = field(default_factory=list)


@dataclass(frozen=True)
class ProxyEndpointConfig:
    host: str
    port: int


@dataclass(frozen=True)
class ProxyConfig:
    http_proxy: ProxyEndpointConfig
    socks5_proxy: ProxyEndpointConfig
    supported_countries: List[str]
    blocked_countries: List[str]
    max_rotation_interval_minutes: int
    min_rotation_interval_minutes: int
    geo_targeting: GeoTargeting


# ──────────────────────────────────────────────────────────────────────
# Admin
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AdminUser:
    id: str
    email: str
    status: str
    plan_id: str
    balance_cents: int
    created_at: str
    is_admin: bool


@dataclass(frozen=True)
class AdminUserDetail:
    id: str
    email: str
    status: str
    plan_id: str
    balance_cents: int
    created_at: str
    is_admin: bool
    api_key_count: int
    total_usage_bytes: int
    total_spent_cents: int
    last_active: Optional[str]


@dataclass(frozen=True)
class Pagination:
    page: int
    limit: int
    total: int
    total_pages: int


@dataclass(frozen=True)
class AdminUsersResponse:
    users: List[AdminUser]
    pagination: Pagination


@dataclass(frozen=True)
class RevenueStats:
    total_revenue_cents: int
    total_revenue_usd: float
    total_transactions: int
    avg_transaction_cents: int
    avg_transaction_usd: float
    top_up_count: int
    unique_paying_users: int
    period: UsagePeriod


@dataclass(frozen=True)
class DailyRevenue:
    date: str
    revenue_cents: int
    revenue_usd: float
    transaction_count: int


@dataclass(frozen=True)
class SystemStats:
    total_users: int
    active_users: int
    suspended_users: int
    total_api_keys: int
    active_api_keys: int
    total_sessions: int
    active_sessions: int


# ──────────────────────────────────────────────────────────────────────
# Slots & Waitlist
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SlotsInfo:
    total: int
    used: int
    remaining: int
    unlimited: bool


@dataclass(frozen=True)
class WaitlistJoinResult:
    message: str


@dataclass(frozen=True)
class WaitlistCount:
    pending: int


# ──────────────────────────────────────────────────────────────────────
# Agentic Wallets
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgenticWallet:
    id: str
    label: str
    balance_cents: int
    spending_limit_cents: int
    status: str
    created_at: str = ""
    daily_limit_cents: Optional[int] = None
    allowed_domains: Optional[List[str]] = None


@dataclass(frozen=True)
class AgenticWalletTransaction:
    id: str
    wallet_id: str
    type: str
    amount_cents: int
    description: str
    session_id: Optional[str] = None
    created_at: str = ""


# ──────────────────────────────────────────────────────────────────────
# Teams
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Team:
    id: str
    name: str
    owner_id: str
    max_members: int
    status: str
    balance_cents: int
    created_at: str = ""


@dataclass(frozen=True)
class TeamMember:
    id: str
    team_id: str
    user_id: str
    email: str
    role: str
    joined_at: str = ""


@dataclass(frozen=True)
class TeamInvite:
    id: str
    team_id: str
    email: str
    role: str
    token: str = ""
    expires_at: str = ""
    created_at: str = ""


@dataclass(frozen=True)
class TeamTransaction:
    id: str
    team_id: str
    type: str
    amount_cents: int
    description: str
    created_at: str = ""


@dataclass(frozen=True)
class TeamKey:
    id: str
    key_prefix: str
    label: str
    created_at: str = ""


@dataclass(frozen=True, repr=False)
class TeamKeyCreateResponse:
    """Returned only on creation -- includes the raw key (shown once)."""
    id: str
    key: str
    key_prefix: str
    label: str

    def __repr__(self) -> str:
        return f"TeamKeyCreateResponse(id={self.id!r}, key_prefix={self.key_prefix!r}, label={self.label!r}, key='[REDACTED]')"


@dataclass(frozen=True)
class TeamDeleteResponse:
    refunded_cents: int
