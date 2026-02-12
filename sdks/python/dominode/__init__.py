"""DomiNode Python SDK.

Official Python SDK for the DomiNode rotating proxy-as-a-service platform.

Provides both synchronous and asynchronous clients::

    # Sync
    from dominode import DomiNodeClient

    with DomiNodeClient(base_url="http://localhost:3000") as client:
        client.connect_with_credentials("user@example.com", "s3cret!Pass")
        print(client.wallet.get_balance())

    # Async
    from dominode import AsyncDomiNodeClient

    async with AsyncDomiNodeClient(base_url="http://localhost:3000") as client:
        await client.connect_with_credentials("user@example.com", "s3cret!Pass")
        print(await client.wallet.get_balance())
"""

from .client import AsyncDomiNodeClient, DomiNodeClient
from .constants import SDK_VERSION
from .errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    DomiNodeError,
    InsufficientBalanceError,
    NetworkError,
    NotFoundError,
    ProxyError,
    RateLimitError,
    ServerError,
    ValidationError,
)
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
    WalletForecast,
    WalletTransaction,
)

__version__ = SDK_VERSION

__all__ = [
    # Clients
    "DomiNodeClient",
    "AsyncDomiNodeClient",
    # Errors
    "DomiNodeError",
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
    "SystemStats",
    # Constants
    "SDK_VERSION",
]
