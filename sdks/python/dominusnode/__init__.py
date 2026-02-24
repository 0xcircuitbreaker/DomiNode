"""Dominus Node Python SDK.

Official Python SDK for the Dominus Node rotating proxy-as-a-service platform.

Provides both synchronous and asynchronous clients::

    # Sync
    from dominusnode import DominusNodeClient

    with DominusNodeClient(base_url="http://localhost:3000") as client:
        client.connect_with_credentials("user@example.com", "s3cret!Pass")
        print(client.wallet.get_balance())

    # Async
    from dominusnode import AsyncDominusNodeClient

    async with AsyncDominusNodeClient(base_url="http://localhost:3000") as client:
        await client.connect_with_credentials("user@example.com", "s3cret!Pass")
        print(await client.wallet.get_balance())
"""

from .client import AsyncDominusNodeClient, DominusNodeClient
from .constants import SDK_VERSION
from .errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    DominusNodeError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    ProxyError,
    RateLimitError,
    ServerError,
    ValidationError,
)
from .x402 import X402Info, X402Facilitator, X402Pricing
from .wallet_auth import WalletChallenge, WalletVerifyResult, WalletLinkResult
from .types import (
    ActiveSession,
    AdminUser,
    AdminUserDetail,
    AdminUsersResponse,
    ApiKey,
    CreatedApiKey,
    CryptoInvoice,
    DailyRevenue,
    DailyUsage,
    GeoTargeting,
    LoginResult,
    MfaSetup,
    MfaStatus,
    Pagination,
    Plan,
    ProxyConfig,
    ProxyEndpointConfig,
    ProxyEndpoints,
    ProxyHealth,
    ProxyStatus,
    ProxyUrlOptions,
    ProviderStat,
    RevenueStats,
    StripeCheckout,
    SlotsInfo,
    SystemStats,
    TopHost,
    UsagePagination,
    UsagePeriod,
    UsageRecord,
    UsageResponse,
    UsageSummary,
    User,
    UserPlanInfo,
    UserPlanUsage,
    Wallet,
    WaitlistCount,
    WaitlistJoinResult,
    WalletForecast,
    WalletTransaction,
)

__version__ = SDK_VERSION

__all__ = [
    # Clients
    "DominusNodeClient",
    "AsyncDominusNodeClient",
    # Errors
    "DominusNodeError",
    "AuthenticationError",
    "AuthorizationError",
    "RateLimitError",
    "InsufficientBalanceError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "ServerError",
    "NetworkError",
    "ProxyError",
    # Types
    "User",
    "LoginResult",
    "MfaStatus",
    "MfaSetup",
    "ApiKey",
    "CreatedApiKey",
    "Wallet",
    "WalletTransaction",
    "WalletForecast",
    "StripeCheckout",
    "CryptoInvoice",
    "UsageSummary",
    "UsageRecord",
    "UsagePagination",
    "UsagePeriod",
    "UsageResponse",
    "DailyUsage",
    "TopHost",
    "Plan",
    "UserPlanUsage",
    "UserPlanInfo",
    "ActiveSession",
    "ProxyUrlOptions",
    "ProxyHealth",
    "ProviderStat",
    "ProxyEndpoints",
    "ProxyStatus",
    "GeoTargeting",
    "ProxyEndpointConfig",
    "ProxyConfig",
    "AdminUser",
    "AdminUserDetail",
    "Pagination",
    "AdminUsersResponse",
    "RevenueStats",
    "DailyRevenue",
    "SlotsInfo",
    "WaitlistJoinResult",
    "WaitlistCount",
    "SystemStats",
    # x402
    "X402Info",
    "X402Facilitator",
    "X402Pricing",
    # Wallet Auth
    "WalletChallenge",
    "WalletVerifyResult",
    "WalletLinkResult",
    # Constants
    "SDK_VERSION",
]
