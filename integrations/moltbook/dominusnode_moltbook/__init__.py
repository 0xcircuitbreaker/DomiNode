"""Dominus Node Moltbook integration -- interact with Moltbook through rotating proxies.

Provides a MoltbookClient that routes all requests to the Moltbook social network
(moltbookai.net) through Dominus Node rotating proxies, so each request comes from a
different IP. Includes 10 Moltbook-specific tools plus 43 Dominus Node management tools
for a total of 53 tools.

Moltbook tools:
  - register, browse_posts, get_post, create_post, comment, vote
  - list_submolts, create_submolt, get_profile, get_proxy_status

Dominus Node management tools:
  - check_balance, check_usage, get_proxy_config, list_sessions
  - Agentic wallet: create, fund, balance, list, transactions, freeze, unfreeze, delete,
    update_policy
  - Wallet: get_transactions, get_forecast, check_payment
  - Usage: get_daily_usage, get_top_hosts
  - Account: register_account, login_account, get_account_info, verify_email,
    resend_verification, update_password
  - API keys: list_keys, create_key, revoke_key
  - Plans: get_plan, list_plans, change_plan
  - Teams: create, list, details, fund, create_key, usage, update, update_member_role,
    delete, revoke_key, list_keys, list_members, add_member, remove_member,
    invite_member, list_invites, cancel_invite
  - Proxy: dn_get_proxy_status
  - x402_info, topup_paypal, topup_stripe, topup_crypto

Security:
  - Full SSRF prevention (private IP blocking, DNS rebinding, Teredo/6to4,
    IPv4-mapped/compatible IPv6, hex/octal/decimal normalization, zone ID
    stripping, .localhost/.local/.internal/.arpa TLD blocking, embedded
    credential blocking)
  - OFAC sanctioned country validation (CU, IR, KP, RU, SY)
  - Credential scrubbing in all error outputs (Dominus Node API keys + ETH private keys)
  - Prototype pollution prevention on all parsed JSON
  - 10 MB response cap, 30 s timeout
  - Redirect following disabled to prevent open redirect abuse
  - ETH private key never logged or included in error messages

Example::

    from dominusnode_moltbook import MoltbookClient

    client = MoltbookClient(
        dominusnode_api_key="dn_live_...",
        eth_address="0x1234...",
        eth_private_key="0xabcd...",
    )
    posts = client.browse_posts(submolt="ai-agents", sort="hot")
    client.create_post(title="Hello from my AI agent", content="...", submolt="general")

Requires: httpx (``pip install httpx``)
"""

from dominusnode_moltbook.client import MoltbookClient

__version__ = "1.0.0"
__all__ = ["MoltbookClient", "__version__"]
