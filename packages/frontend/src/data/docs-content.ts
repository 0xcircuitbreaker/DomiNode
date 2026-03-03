// ---------------------------------------------------------------------------
// Dominus Node Documentation Content
// ---------------------------------------------------------------------------

export interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: "Public" | "JWT" | "API Key" | "Signature" | "JWT | API Key";
  description: string;
}

export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export type DocContent =
  | { type: "text"; text: string }
  | { type: "code"; lang: string; code: string; label?: string }
  | { type: "endpoint-table"; endpoints: Endpoint[] }
  | { type: "param-table"; params: Param[] }
  | { type: "note"; variant: "info" | "warning" | "danger" | "tip"; text: string }
  | { type: "heading"; level: 3 | 4; text: string };

export interface DocSubsection {
  id: string;
  title: string;
  content: DocContent[];
  searchTerms?: string[];
}

export interface DocSection {
  id: string;
  title: string;
  icon: string;
  subsections: DocSubsection[];
}

// ---------------------------------------------------------------------------
// Section 1: Quick Start
// ---------------------------------------------------------------------------

const quickStart: DocSection = {
  id: "quick-start",
  title: "Quick Start",
  icon: "⚡",
  subsections: [
    {
      id: "qs-install",
      title: "Install an SDK",
      searchTerms: ["install", "npm", "pip", "go get", "cargo", "maven"],
      content: [
        { type: "text", text: "Choose your language to get started in minutes. All SDKs are zero-dependency (or minimal) and support both test and live API keys." },
        { type: "code", lang: "bash", label: "Node.js", code: "npm install @dominusnode/node-sdk" },
        { type: "code", lang: "bash", label: "Python", code: "pip install dominusnode" },
        { type: "code", lang: "bash", label: "Go", code: "go get github.com/Dominus-Node/dominusnode-go" },
        { type: "code", lang: "bash", label: "Rust", code: "cargo add dominusnode" },
        { type: "code", lang: "bash", label: "Java (Maven)", code: `<dependency>
  <groupId>com.dominusnode</groupId>
  <artifactId>dominusnode-java</artifactId>
  <version>1.0.0</version>
</dependency>` },
        { type: "code", lang: "bash", label: "C++", code: "# Copy sdk/dominusnode.hpp into your project\n# Requires: libcurl with TLS" },
      ],
    },
    {
      id: "qs-api-key",
      title: "Generate an API Key",
      searchTerms: ["api key", "token", "register", "login", "credentials"],
      content: [
        { type: "text", text: "Register an account, then create an API key. Keys start with dn_live_ (production) or dn_test_ (sandbox)." },
        { type: "code", lang: "bash", label: "Register", code: `curl -X POST https://api.dominusnode.com/api/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"hunter2"}'` },
        { type: "code", lang: "bash", label: "Login", code: `curl -X POST https://api.dominusnode.com/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"hunter2"}'
# → { "token": "eyJ...", "refreshToken": "..." }` },
        { type: "code", lang: "bash", label: "Create API Key", code: `curl -X POST https://api.dominusnode.com/api/keys \\
  -H 'Authorization: Bearer eyJ...' \\
  -H 'Content-Type: application/json' \\
  -d '{"label":"my-agent"}'
# → { "key": "dn_live_abc123...", "id": "...", "label": "my-agent" }` },
        { type: "note", variant: "warning", text: "The raw API key is shown only once on creation. Store it in an environment variable immediately." },
      ],
    },
    {
      id: "qs-first-request",
      title: "Make Your First Proxy Request",
      searchTerms: ["first request", "proxy", "curl", "test", "httpbin"],
      content: [
        { type: "text", text: "Route HTTP/HTTPS traffic through Dominus Node by using your API key as the proxy password." },
        { type: "code", lang: "bash", label: "Default (DC + residential fallback)", code: `curl -x http://anything:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 \\
  https://httpbin.org/ip` },
        { type: "code", lang: "bash", label: "Explicit datacenter pool", code: `curl -x http://dc-country-US:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 \\
  https://httpbin.org/ip` },
        { type: "code", lang: "bash", label: "Explicit residential pool", code: `curl -x http://residential-country-GB:dn_live_YOUR_KEY@proxy.dominusnode.com:8080 \\
  https://httpbin.org/ip` },
        { type: "code", lang: "bash", label: "SOCKS5", code: `curl --socks5 socks5://anything:dn_live_YOUR_KEY@proxy.dominusnode.com:1080 \\
  https://httpbin.org/ip` },
        { type: "code", lang: "javascript", label: "Node.js SDK", code: `import { DominusNodeClient } from '@dominusnode/node-sdk';

const client = new DominusNodeClient({ apiKey: process.env.DOMINUSNODE_API_KEY });

// Get your proxy config
const config = await client.proxy.getConfig();
console.log(config.httpProxy); // { host, port }` },
      ],
    },
    {
      id: "qs-top-up",
      title: "Top Up Your Wallet",
      searchTerms: ["top up", "wallet", "balance", "stripe", "billing", "pay"],
      content: [
        { type: "text", text: "Dominus Node uses a prepaid wallet system. Fund your wallet via Stripe, PayPal, or 11 cryptocurrencies. Usage is debited per byte." },
        { type: "code", lang: "bash", label: "Check balance", code: `curl https://api.dominusnode.com/api/wallet \\
  -H 'Authorization: Bearer eyJ...'
# → { "balance": 1050, "balanceUsd": "10.50" }` },
        { type: "code", lang: "bash", label: "Top up via Stripe", code: `curl -X POST https://api.dominusnode.com/api/wallet/topup/stripe \\
  -H 'Authorization: Bearer eyJ...' \\
  -H 'Content-Type: application/json' \\
  -d '{"amountCents": 1000}'
# → { "sessionId": "cs_...", "url": "https://checkout.stripe.com/..." }` },
        { type: "note", variant: "info", text: "Datacenter bandwidth is billed at $3.00/GB. Residential bandwidth is billed at $5.00/GB. There is no monthly subscription — you only pay for what you use." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 2: Authentication
// ---------------------------------------------------------------------------

const authentication: DocSection = {
  id: "authentication",
  title: "Authentication",
  icon: "🔐",
  subsections: [
    {
      id: "auth-api-keys",
      title: "API Keys",
      searchTerms: ["api key", "dn_live", "dn_test", "proxy auth", "bearer"],
      content: [
        { type: "text", text: "API keys authenticate both proxy connections and REST API calls. Keys are prefixed with dn_live_ (production) or dn_test_ (sandbox). Raw key values are never stored — only a cryptographic hash is kept server-side, so your credentials remain safe even in a worst-case scenario." },
        { type: "heading", level: 3, text: "Proxy authentication (Basic Auth)" },
        { type: "code", lang: "bash", code: `# Format: http://<username>:<api-key>@<proxy-host>:<port>
# username = routing options (any string for default routing)
# username = dc-country-US  → datacenter pool, US exit
# username = residential-country-DE  → residential pool, DE exit
curl -x http://dc-country-US:dn_live_abc123@proxy.dominusnode.com:8080 https://httpbin.org/ip` },
        { type: "heading", level: 3, text: "REST API authentication (Bearer token)" },
        { type: "code", lang: "bash", code: `curl https://api.dominusnode.com/api/wallet \\
  -H 'Authorization: Bearer eyJ...'` },
        { type: "note", variant: "info", text: "API keys can also be used in REST API calls as Bearer tokens directly, in addition to JWT tokens." },
      ],
    },
    {
      id: "auth-jwt",
      title: "JWT & Refresh Tokens",
      searchTerms: ["jwt", "refresh token", "access token", "15 min", "7 day", "rotation"],
      content: [
        { type: "text", text: "JWT access tokens expire after 15 minutes. Refresh tokens are valid for 7 days and automatically issue a new token on each use — using an old token again invalidates all your sessions immediately." },
        { type: "code", lang: "bash", label: "Login → get tokens", code: `curl -X POST https://api.dominusnode.com/api/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"hunter2"}'
# → { "token": "eyJ...", "refreshToken": "rt_...", "expiresIn": 900 }` },
        { type: "code", lang: "bash", label: "Refresh access token", code: `curl -X POST https://api.dominusnode.com/api/auth/refresh \\
  -H 'Content-Type: application/json' \\
  -d '{"refreshToken":"rt_..."}'
# → { "token": "eyJ...", "refreshToken": "rt_new..." }` },
        { type: "note", variant: "warning", text: "Refresh tokens are single-use. If a token is reused after being consumed, all active sessions for that account are immediately invalidated as a security precaution." },
      ],
    },
    {
      id: "auth-wallet",
      title: "Wallet (EIP-191) Authentication",
      searchTerms: ["wallet", "eip-191", "ethereum", "metamask", "signature", "web3", "crypto"],
      content: [
        { type: "text", text: "Register or login with an Ethereum wallet using EIP-191 message signing — no email or password required. Useful for AI agents and crypto-native users." },
        { type: "code", lang: "bash", label: "Step 1: Request challenge", code: `curl -X POST https://api.dominusnode.com/api/auth/wallet/challenge \\
  -H 'Content-Type: application/json' \\
  -d '{"address":"0xYourEthAddress"}'
# → { "challenge": "Dominus Node login: <nonce>", "expiresAt": "..." }` },
        { type: "code", lang: "bash", label: "Step 2: Sign & verify", code: `curl -X POST https://api.dominusnode.com/api/auth/wallet/verify \\
  -H 'Content-Type: application/json' \\
  -d '{
    "address": "0xYourEthAddress",
    "signature": "0x<130-hex-char EIP-191 sig>"
  }'
# → { "token": "eyJ...", "refreshToken": "rt_...", "created": true }` },
        { type: "code", lang: "bash", label: "Link wallet to existing account", code: `curl -X POST https://api.dominusnode.com/api/auth/wallet/link \\
  -H 'Authorization: Bearer eyJ...' \\
  -H 'Content-Type: application/json' \\
  -d '{"address":"0xYourEthAddress","signature":"0x..."}'` },
        { type: "note", variant: "info", text: "The signature must be a standard EIP-191 personal_sign signature: 0x followed by exactly 130 hex characters." },
      ],
    },
    {
      id: "auth-mfa",
      title: "MFA / TOTP",
      searchTerms: ["mfa", "totp", "2fa", "authenticator", "backup codes", "otp"],
      content: [
        { type: "text", text: "Enable two-factor authentication using any TOTP authenticator (Google Authenticator, Authy, etc.). 10 single-use backup codes are generated on setup." },
        { type: "code", lang: "bash", label: "Enable MFA (Security page)", code: `curl -X POST https://api.dominusnode.com/api/auth/mfa/setup \\
  -H 'Authorization: Bearer eyJ...'
# → { "secret": "BASE32SECRET", "qrUrl": "otpauth://totp/..." }` },
        { type: "code", lang: "bash", label: "Verify TOTP to activate", code: `curl -X POST https://api.dominusnode.com/api/auth/mfa/verify \\
  -H 'Authorization: Bearer eyJ...' \\
  -H 'Content-Type: application/json' \\
  -d '{"token":"123456"}'` },
        { type: "code", lang: "bash", label: "Login with MFA", code: `# 1. Login → get MFA challenge token
curl -X POST https://api.dominusnode.com/api/auth/login \\
  -d '{"email":"...","password":"..."}'
# → { "mfaRequired": true, "challengeToken": "eyJ..." }

# 2. Submit TOTP
curl -X POST https://api.dominusnode.com/api/auth/mfa/challenge \\
  -H 'Content-Type: application/json' \\
  -d '{"challengeToken":"eyJ...","totpToken":"123456"}'
# → { "token": "eyJ...", "refreshToken": "rt_..." }` },
        { type: "note", variant: "tip", text: "Backup codes can be used in place of TOTP. Each code is single-use. Generate new backup codes from the Security page at any time." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 3: Proxy Usage
// ---------------------------------------------------------------------------

const proxyUsage: DocSection = {
  id: "proxy-usage",
  title: "Proxy Usage",
  icon: "🌐",
  subsections: [
    {
      id: "proxy-endpoints",
      title: "Proxy Endpoints",
      searchTerms: ["http proxy", "socks5", "port", "8080", "1080", "connect", "tunnel"],
      content: [
        { type: "text", text: "Dominus Node exposes two proxy endpoints:" },
        {
          type: "param-table", params: [
            { name: "HTTP/HTTPS Proxy", type: "host:port", required: true, description: "proxy.dominusnode.com:8080 — supports HTTP CONNECT tunneling for HTTPS" },
            { name: "SOCKS5 Proxy", type: "host:port", required: true, description: "proxy.dominusnode.com:1080 — supports SOCKS5 protocol, works with most clients" },
          ],
        },
      ],
    },
    {
      id: "proxy-auth-format",
      title: "Username / Routing Format",
      searchTerms: ["username", "routing", "pool type", "country", "sticky", "session"],
      content: [
        { type: "text", text: "The proxy username field controls routing. The password is always your API key." },
        {
          type: "param-table", params: [
            { name: "any string", type: "username", required: false, description: "Default: auto-selects DC pool, falls back to residential" },
            { name: "dc", type: "username", required: false, description: "Force datacenter pool ($3/GB)" },
            { name: "residential", type: "username", required: false, description: "Force residential pool ($5/GB)" },
            { name: "dc-country-US", type: "username", required: false, description: "Datacenter, US exit node" },
            { name: "residential-country-GB", type: "username", required: false, description: "Residential, UK exit node" },
            { name: "residential-country-DE-session-abc", type: "username", required: false, description: "Residential, DE, sticky session ID 'abc'" },
          ],
        },
        { type: "code", lang: "bash", label: "Examples", code: `# Auto pool selection
curl -x http://auto:dn_live_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# Datacenter, US exit
curl -x http://dc-country-US:dn_live_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# Residential, Germany
curl -x http://residential-country-DE:dn_live_KEY@proxy.dominusnode.com:8080 https://httpbin.org/ip

# Sticky residential session (reuses same IP for duration of session)
curl -x http://residential-country-US-session-mybot42:dn_live_KEY@proxy.dominusnode.com:8080 \\
  https://httpbin.org/ip` },
        { type: "note", variant: "warning", text: "Country codes must be valid ISO 3166-1 alpha-2 codes (e.g., US, GB, DE). OFAC-sanctioned countries (CU, IR, KP, RU, SY) are blocked." },
      ],
    },
    {
      id: "proxy-sdk",
      title: "SDK Proxy Configuration",
      searchTerms: ["sdk", "proxy config", "http client", "agent", "urllib", "requests"],
      content: [
        { type: "text", text: "Each SDK provides a proxy configuration helper that returns the correct HTTP proxy URL and credentials for use with any HTTP client." },
        { type: "code", lang: "javascript", label: "Node.js", code: `import { DominusNodeClient } from '@dominusnode/node-sdk';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const client = new DominusNodeClient({ apiKey: process.env.DOMINUSNODE_API_KEY });
const { httpProxy } = await client.proxy.getConfig();
const proxyUrl = \`http://dc-country-US:\${process.env.DOMINUSNODE_API_KEY}@\${httpProxy.host}:\${httpProxy.port}\`;

const agent = new HttpsProxyAgent(proxyUrl);
const resp = await fetch('https://httpbin.org/ip', { agent });` },
        { type: "code", lang: "python", label: "Python", code: `import os, requests
from dominusnode import DominusNodeClient

client = DominusNodeClient(api_key=os.environ["DOMINUSNODE_API_KEY"])
config = client.proxy.get_config()
proxy_url = f"http://dc-country-US:{os.environ['DOMINUSNODE_API_KEY']}@{config['httpProxy']['host']}:{config['httpProxy']['port']}"

resp = requests.get("https://httpbin.org/ip", proxies={"https": proxy_url})
print(resp.json())` },
      ],
    },
    {
      id: "proxy-billing",
      title: "How Billing Works",
      searchTerms: ["billing", "bytes", "reservation", "debit", "wallet", "session"],
      content: [
        { type: "text", text: "Dominus Node uses a reservation-then-settle model:" },
        {
          type: "param-table", params: [
            { name: "Session start", type: "event", required: true, description: "$0.50 pre-authorized from your wallet to open the session" },
            { name: "In-session", type: "event", required: true, description: "Bytes in + out counted in real time" },
            { name: "Session end", type: "event", required: true, description: "Actual cost settled, unused reservation released" },
          ],
        },
        { type: "note", variant: "info", text: "Datacenter pool: $3.00/GB. Residential pool: $5.00/GB. A minimum balance of $0.50 is required to open a new proxy session." },
        { type: "note", variant: "danger", text: "Sessions will be terminated if wallet balance drops to zero mid-session. Keep sufficient balance for your workload." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 4: REST API Reference
// ---------------------------------------------------------------------------

const apiReference: DocSection = {
  id: "api-reference",
  title: "REST API Reference",
  icon: "📡",
  subsections: [
    {
      id: "api-auth",
      title: "Authentication",
      searchTerms: ["register", "login", "logout", "refresh", "me", "verify", "password", "mfa"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/auth/register", auth: "Public", description: "Create a new account with email + password" },
            { method: "POST", path: "/api/auth/login", auth: "Public", description: "Login and receive JWT + refresh token" },
            { method: "POST", path: "/api/auth/refresh", auth: "Public", description: "Exchange refresh token for new access token" },
            { method: "POST", path: "/api/auth/logout", auth: "JWT", description: "Revoke current refresh token" },
            { method: "GET", path: "/api/auth/me", auth: "JWT", description: "Get current user profile" },
            { method: "POST", path: "/api/auth/verify-email", auth: "Public", description: "Verify email address with token" },
            { method: "POST", path: "/api/auth/resend-verify", auth: "JWT", description: "Resend email verification link" },
            { method: "POST", path: "/api/auth/forgot-password", auth: "Public", description: "Request a password reset email" },
            { method: "POST", path: "/api/auth/reset-password", auth: "Public", description: "Reset password using token" },
            { method: "GET", path: "/api/health", auth: "Public", description: "Health check — returns service status" },
          ],
        },
      ],
    },
    {
      id: "api-mfa",
      title: "MFA",
      searchTerms: ["mfa", "totp", "2fa", "setup", "disable", "backup codes"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/auth/mfa/setup", auth: "JWT", description: "Generate TOTP secret and QR code URL" },
            { method: "POST", path: "/api/auth/mfa/verify", auth: "JWT", description: "Verify TOTP token to activate MFA" },
            { method: "POST", path: "/api/auth/mfa/disable", auth: "JWT", description: "Disable MFA (requires TOTP or backup code)" },
            { method: "POST", path: "/api/auth/mfa/challenge", auth: "Public", description: "Complete MFA login with challenge token + TOTP" },
            { method: "GET", path: "/api/auth/mfa/backup-codes", auth: "JWT", description: "List backup code statuses (masked)" },
            { method: "POST", path: "/api/auth/mfa/backup-codes/regenerate", auth: "JWT", description: "Regenerate all 10 backup codes" },
          ],
        },
      ],
    },
    {
      id: "api-wallet-auth",
      title: "Wallet Authentication",
      searchTerms: ["wallet", "eip-191", "ethereum", "challenge", "link"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/auth/wallet/challenge", auth: "Public", description: "Request an EIP-191 signature challenge for a wallet address" },
            { method: "POST", path: "/api/auth/wallet/verify", auth: "Public", description: "Submit signed challenge to create account or login" },
            { method: "POST", path: "/api/auth/wallet/link", auth: "JWT", description: "Link an Ethereum wallet to an existing account" },
          ],
        },
      ],
    },
    {
      id: "api-keys",
      title: "API Keys",
      searchTerms: ["api key", "create key", "list keys", "revoke key", "label"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/keys", auth: "JWT", description: "Create a new API key (key shown once)" },
            { method: "GET", path: "/api/keys", auth: "JWT", description: "List all API keys (key values are never returned after initial creation)" },
            { method: "DELETE", path: "/api/keys/:id", auth: "JWT", description: "Revoke an API key by ID" },
          ],
        },
      ],
    },
    {
      id: "api-wallet",
      title: "Wallet & Payments",
      searchTerms: ["wallet", "balance", "topup", "stripe", "paypal", "crypto", "transactions", "invoice", "x402"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/wallet", auth: "JWT", description: "Get wallet balance in cents and USD" },
            { method: "GET", path: "/api/wallet/transactions", auth: "JWT", description: "Transaction history (paginated)" },
            { method: "POST", path: "/api/wallet/topup/stripe", auth: "JWT", description: "Create Stripe Checkout session for wallet top-up" },
            { method: "POST", path: "/api/wallet/topup/paypal", auth: "JWT", description: "Create PayPal order for wallet top-up" },
            { method: "POST", path: "/api/wallet/topup/paypal/:orderId/capture", auth: "JWT", description: "Capture an approved PayPal order" },
            { method: "POST", path: "/api/wallet/topup/crypto", auth: "JWT", description: "Create NOWPayments crypto invoice (BTC/ETH/SOL/XMR/ZEC/USDC/USDT/DAI/BNB/LINK/LTC)" },
            { method: "GET", path: "/api/wallet/crypto/status/:invoiceId", auth: "JWT", description: "Check crypto invoice payment status" },
            { method: "POST", path: "/api/webhooks/stripe", auth: "Signature", description: "Stripe webhook (stripe-signature header)" },
            { method: "POST", path: "/api/webhooks/nowpayments", auth: "Signature", description: "NOWPayments IPN webhook" },
          ],
        },
      ],
    },
    {
      id: "api-usage",
      title: "Usage",
      searchTerms: ["usage", "bandwidth", "bytes", "stats", "history", "sessions"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/usage", auth: "JWT | API Key", description: "Usage statistics (since/until ISO date params)" },
            { method: "GET", path: "/api/usage/sessions", auth: "JWT | API Key", description: "Active and recent proxy sessions" },
            { method: "GET", path: "/api/usage/hosts", auth: "JWT | API Key", description: "Top target hostnames by bytes (paginated)" },
            { method: "GET", path: "/api/usage/export", auth: "JWT", description: "Export usage CSV for date range" },
          ],
        },
      ],
    },
    {
      id: "api-plans",
      title: "Plans",
      searchTerms: ["plan", "free", "payg", "volume", "upgrade", "billing tier"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/plans", auth: "Public", description: "List all available plans with pricing" },
            { method: "GET", path: "/api/plans/current", auth: "JWT", description: "Get current user plan details" },
            { method: "POST", path: "/api/plans/change", auth: "JWT", description: "Change to a different plan (email verified required)" },
          ],
        },
      ],
    },
    {
      id: "api-teams",
      title: "Teams",
      searchTerms: ["teams", "members", "invite", "owner", "admin", "roles", "shared wallet", "team key"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/teams", auth: "JWT", description: "Create a new team" },
            { method: "GET", path: "/api/teams", auth: "JWT", description: "List teams you belong to" },
            { method: "GET", path: "/api/teams/:teamId", auth: "JWT", description: "Get team details" },
            { method: "PATCH", path: "/api/teams/:teamId", auth: "JWT", description: "Update team name/settings (admin+)" },
            { method: "DELETE", path: "/api/teams/:teamId", auth: "JWT", description: "Delete team (owner only)" },
            { method: "GET", path: "/api/teams/:teamId/wallet", auth: "JWT", description: "Get team wallet balance" },
            { method: "POST", path: "/api/teams/:teamId/wallet/fund", auth: "JWT", description: "Fund team wallet from personal wallet" },
            { method: "GET", path: "/api/teams/:teamId/members", auth: "JWT", description: "List team members and roles" },
            { method: "POST", path: "/api/teams/:teamId/members", auth: "JWT", description: "Add member directly (admin+, email verified)" },
            { method: "DELETE", path: "/api/teams/:teamId/members/:userId", auth: "JWT", description: "Remove a team member" },
            { method: "PATCH", path: "/api/teams/:teamId/members/:userId/role", auth: "JWT", description: "Update member role (owner only)" },
            { method: "POST", path: "/api/teams/:teamId/invites", auth: "JWT", description: "Invite user by email" },
            { method: "GET", path: "/api/teams/:teamId/invites", auth: "JWT", description: "List pending invites" },
            { method: "DELETE", path: "/api/teams/:teamId/invites/:inviteId", auth: "JWT", description: "Cancel a pending invite" },
            { method: "POST", path: "/api/teams/invite/accept", auth: "Public", description: "Accept team invite via token link" },
            { method: "POST", path: "/api/teams/:teamId/keys", auth: "JWT", description: "Create a team API key" },
            { method: "GET", path: "/api/teams/:teamId/keys", auth: "JWT", description: "List team API keys" },
            { method: "DELETE", path: "/api/teams/:teamId/keys/:keyId", auth: "JWT", description: "Revoke a team API key" },
          ],
        },
        { type: "note", variant: "info", text: "Team API keys bill to the team wallet. Personal API keys always bill to the personal wallet." },
      ],
    },
    {
      id: "api-agentic",
      title: "Agentic Wallets",
      searchTerms: ["agentic wallet", "agent", "spending limit", "sub-wallet", "freeze", "unfreeze", "fund", "custodial"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "POST", path: "/api/agent-wallet", auth: "JWT | API Key", description: "Create an agentic sub-wallet with spending limit" },
            { method: "GET", path: "/api/agent-wallet", auth: "JWT | API Key", description: "List all agentic wallets" },
            { method: "GET", path: "/api/agent-wallet/:walletId", auth: "JWT | API Key", description: "Get agentic wallet balance and details" },
            { method: "POST", path: "/api/agent-wallet/:walletId/fund", auth: "JWT | API Key", description: "Fund agentic wallet from main wallet" },
            { method: "GET", path: "/api/agent-wallet/:walletId/transactions", auth: "JWT | API Key", description: "Agentic wallet transaction history" },
            { method: "POST", path: "/api/agent-wallet/:walletId/freeze", auth: "JWT | API Key", description: "Freeze wallet (blocks spending)" },
            { method: "POST", path: "/api/agent-wallet/:walletId/unfreeze", auth: "JWT | API Key", description: "Unfreeze wallet (re-enables spending)" },
            { method: "DELETE", path: "/api/agent-wallet/:walletId", auth: "JWT | API Key", description: "Delete wallet and refund balance to main wallet" },
          ],
        },
        { type: "note", variant: "tip", text: "Use agentic wallets to give AI agents limited, auditable spending authority. Each wallet has a per-transaction spending limit. Maximum balance: $100.00." },
      ],
    },
    {
      id: "api-referrals",
      title: "Referrals & Loyalty",
      searchTerms: ["referral", "affiliate", "promo code", "loyalty", "cashback", "commission"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/referrals/code", auth: "JWT", description: "Get your referral code" },
            { method: "POST", path: "/api/referrals/redeem", auth: "JWT", description: "Redeem a referral code on signup" },
            { method: "GET", path: "/api/referrals/stats", auth: "JWT", description: "View referral stats (referrals, earnings)" },
            { method: "GET", path: "/api/referrals/affiliate", auth: "JWT", description: "Get affiliate link info" },
            { method: "GET", path: "/api/referrals/affiliate/commissions", auth: "JWT", description: "List affiliate commission earnings" },
            { method: "POST", path: "/api/referrals/promo/check", auth: "JWT", description: "Check if a promo code is valid" },
            { method: "POST", path: "/api/referrals/promo/redeem", auth: "JWT", description: "Redeem a promo code for wallet credit" },
            { method: "GET", path: "/api/referrals/loyalty/tier", auth: "JWT", description: "Get current loyalty tier (none/bronze/silver/gold)" },
            { method: "GET", path: "/api/referrals/loyalty/rewards", auth: "JWT", description: "List loyalty cashback reward history" },
            { method: "GET", path: "/api/referrals/gdpr/export", auth: "JWT", description: "Export all referral data (GDPR)" },
            { method: "DELETE", path: "/api/referrals/gdpr/delete", auth: "JWT", description: "Delete all referral data (GDPR)" },
          ],
        },
      ],
    },
    {
      id: "api-account",
      title: "Account",
      searchTerms: ["account", "delete", "gdpr", "export", "profile", "password change", "sessions"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/auth/sessions", auth: "JWT", description: "List active sessions across devices" },
            { method: "DELETE", path: "/api/auth/sessions/:sessionId", auth: "JWT", description: "Revoke a specific session" },
            { method: "GET", path: "/api/gdpr/export", auth: "JWT", description: "Export all personal data (GDPR Article 20)" },
            { method: "DELETE", path: "/api/gdpr/delete", auth: "JWT", description: "Permanently delete account and all data (GDPR Article 17)" },
          ],
        },
        { type: "note", variant: "danger", text: "Account deletion is immediate and irreversible. All data, wallet balance, and API keys are permanently removed." },
      ],
    },
    {
      id: "api-x402",
      title: "x402 Micropayments",
      searchTerms: ["x402", "micropayments", "usdc", "coinbase", "payai", "http 402", "pay per request"],
      content: [
        {
          type: "endpoint-table", endpoints: [
            { method: "GET", path: "/api/x402/info", auth: "Public", description: "x402 payment requirements for the proxy endpoint" },
          ],
        },
        { type: "note", variant: "info", text: "The proxy gateway itself handles x402 inline. See the x402 Protocol section for the full client flow." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 5: SDK Reference
// ---------------------------------------------------------------------------

const sdkReference: DocSection = {
  id: "sdk-reference",
  title: "SDK Reference",
  icon: "📦",
  subsections: [
    {
      id: "sdk-node",
      title: "Node.js SDK",
      searchTerms: ["node", "typescript", "javascript", "npm", "cjs", "esm"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/node-sdk" },
        { type: "code", lang: "javascript", label: "Quick start", code: `import { DominusNodeClient } from '@dominusnode/node-sdk';

const client = new DominusNodeClient({
  apiKey: process.env.DOMINUSNODE_API_KEY,
  // Optional: baseUrl, proxyHost, proxyPort
});

// Wallet
const wallet = await client.wallet.getBalance();
const topup = await client.wallet.topupStripe({ amountCents: 1000 });

// API Keys
const key = await client.keys.create({ label: 'my-agent' });
const keys = await client.keys.list();
await client.keys.revoke(keyId);

// Usage
const usage = await client.usage.getStats({ since: '2025-01-01', until: '2025-12-31' });

// Agentic Wallets
const agWallet = await client.agenticWallet.create({ label: 'agent-1', spendingLimitCents: 500 });
await client.agenticWallet.fund(agWallet.id, { amountCents: 200 });

// Teams
const team = await client.teams.create({ name: 'My Team' });
await client.teams.inviteMember(team.id, { email: 'member@example.com' });` },
        { type: "note", variant: "info", text: "Zero dependencies. Ships as dual CJS + ESM with TypeScript types. Requires Node.js 18+." },
      ],
    },
    {
      id: "sdk-python",
      title: "Python SDK",
      searchTerms: ["python", "pip", "requests", "async", "pydantic"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "pip install dominusnode" },
        { type: "code", lang: "python", label: "Quick start", code: `import os
from dominusnode import DominusNodeClient

client = DominusNodeClient(api_key=os.environ["DOMINUSNODE_API_KEY"])

# Wallet
wallet = client.wallet.get_balance()
topup = client.wallet.topup_stripe(amount_cents=1000)

# API Keys
key = client.keys.create(label="my-agent")
keys = client.keys.list()
client.keys.revoke(key_id)

# Usage
usage = client.usage.get_stats(since="2025-01-01", until="2025-12-31")

# Agentic Wallets
ag_wallet = client.agentic_wallet.create(label="agent-1", spending_limit_cents=500)
client.agentic_wallet.fund(ag_wallet["id"], amount_cents=200)

# Teams
team = client.teams.create(name="My Team")
client.teams.invite_member(team["id"], email="member@example.com")` },
        { type: "note", variant: "info", text: "Minimal dependencies (requests, pydantic). Supports Python 3.8+." },
      ],
    },
    {
      id: "sdk-go",
      title: "Go SDK",
      searchTerms: ["go", "golang", "go get", "module"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "go get github.com/Dominus-Node/dominusnode-go" },
        { type: "code", lang: "go", label: "Quick start", code: `package main

import (
    "fmt"
    "os"
    dominusnode "github.com/Dominus-Node/dominusnode-go"
)

func main() {
    client := dominusnode.NewClient(os.Getenv("DOMINUSNODE_API_KEY"))

    wallet, _ := client.Wallet.GetBalance()
    fmt.Printf("Balance: $%.2f\\n", float64(wallet.Balance)/100)

    key, _ := client.Keys.Create("my-agent")
    fmt.Println("API Key:", key.Label)

    agWallet, _ := client.AgenticWallet.Create("agent-1", 500)
    client.AgenticWallet.Fund(agWallet.ID, 200)
}` },
      ],
    },
    {
      id: "sdk-rust",
      title: "Rust SDK",
      searchTerms: ["rust", "cargo", "tokio", "async"],
      content: [
        { type: "code", lang: "toml", label: "Cargo.toml", code: `[dependencies]
dominusnode = "1.0"
tokio = { version = "1", features = ["full"] }` },
        { type: "code", lang: "rust", label: "Quick start", code: `use dominusnode::DominusNodeClient;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = DominusNodeClient::new(env::var("DOMINUSNODE_API_KEY")?);

    let wallet = client.wallet().get_balance().await?;
    println!("Balance: {} cents", wallet.balance);

    let key = client.keys().create("my-agent").await?;
    println!("Created key: {}", key.label);

    Ok(())
}` },
      ],
    },
    {
      id: "sdk-java",
      title: "Java SDK",
      searchTerms: ["java", "maven", "gradle", "jvm", "okhttp"],
      content: [
        { type: "code", lang: "xml", label: "Maven dependency", code: `<dependency>
  <groupId>com.dominusnode</groupId>
  <artifactId>dominusnode-java</artifactId>
  <version>1.0.0</version>
</dependency>` },
        { type: "code", lang: "java", label: "Quick start", code: `import io.dominusnode.sdk.DominusNodeClient;
import io.dominusnode.sdk.types.*;

public class Example {
    public static void main(String[] args) {
        DominusNodeClient client = new DominusNodeClient(System.getenv("DOMINUSNODE_API_KEY"));

        WalletBalance wallet = client.wallet().getBalance();
        System.out.println("Balance: " + wallet.getBalance() + " cents");

        ApiKey key = client.keys().create("my-agent");
        System.out.println("Key label: " + key.getLabel());
    }
}` },
      ],
    },
    {
      id: "sdk-cpp",
      title: "C++ SDK",
      searchTerms: ["c++", "cpp", "libcurl", "header-only"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "# Single header — copy into your project\ncp dominusnode.hpp /your/project/include/" },
        { type: "code", lang: "cpp", label: "Quick start", code: `#include "dominusnode.hpp"
#include <cstdlib>
#include <iostream>

int main() {
    std::string apiKey = std::getenv("DOMINUSNODE_API_KEY");
    DominusNodeClient client(apiKey);

    auto wallet = client.wallet().getBalance();
    std::cout << "Balance: " << wallet.balance << " cents" << std::endl;

    auto key = client.keys().create("my-agent");
    std::cout << "Key label: " << key.label << std::endl;

    return 0;
}` },
        { type: "note", variant: "info", text: "Requires libcurl with TLS. Link with -lcurl. C++17 or later." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 6: MCP Server
// ---------------------------------------------------------------------------

const mcpServer: DocSection = {
  id: "mcp-server",
  title: "MCP Server",
  icon: "🤖",
  subsections: [
    {
      id: "mcp-install",
      title: "Installation & Setup",
      searchTerms: ["mcp", "npx", "claude", "cursor", "vs code", "install", "bootstrap"],
      content: [
        { type: "text", text: "Dominus Node ships a full MCP (Model Context Protocol) server with 59+ tools. AI agents can authenticate, manage proxies, and handle payments entirely via MCP." },
        { type: "code", lang: "bash", label: "One-line install", code: "npx @dominusnode/mcp-server" },
        { type: "heading", level: 3, text: "Platform configurations" },
        { type: "code", lang: "json", label: "Claude Desktop (~/.claude/config.json)", code: `{
  "mcpServers": {
    "dominusnode": {
      "command": "npx",
      "args": ["-y", "@dominusnode/mcp-server"]
    }
  }
}` },
        { type: "code", lang: "bash", label: "Claude Code", code: "claude mcp add dominusnode -- npx -y @dominusnode/mcp-server" },
        { type: "code", lang: "json", label: "Cursor / VS Code", code: `{
  "mcp": {
    "servers": {
      "dominusnode": {
        "command": "npx",
        "args": ["-y", "@dominusnode/mcp-server"]
      }
    }
  }
}` },
        { type: "note", variant: "tip", text: "Set DOMINUSNODE_API_KEY in your environment before launching. Without a key, the server enters bootstrap mode — allowing agents to register and create keys autonomously." },
      ],
    },
    {
      id: "mcp-bootstrap",
      title: "Bootstrap Mode (No API Key)",
      searchTerms: ["bootstrap", "register", "no api key", "autonomous", "agent onboarding"],
      content: [
        { type: "text", text: "Without an API key, the MCP server exposes bootstrap tools that let AI agents create accounts and generate their own credentials." },
        {
          type: "param-table", params: [
            { name: "dominusnode_setup", type: "tool", required: false, description: "Complete setup: register, verify email, create API key" },
            { name: "dominusnode_register", type: "tool", required: false, description: "Create a new account with email/password" },
            { name: "dominusnode_login", type: "tool", required: false, description: "Login to existing account" },
            { name: "dominusnode_create_key", type: "tool", required: false, description: "Create an API key after authentication" },
            { name: "dominusnode_pay_stripe", type: "tool", required: false, description: "Create Stripe checkout for wallet top-up" },
            { name: "dominusnode_pay_paypal", type: "tool", required: false, description: "Create PayPal order for wallet top-up" },
            { name: "dominusnode_pay_crypto", type: "tool", required: false, description: "Create crypto invoice ($5 min, 10 currencies)" },
          ],
        },
        { type: "note", variant: "info", text: "AI agents registering through the MCP server are automatically verified — no email confirmation required. Agents can start using the proxy immediately after account creation." },
      ],
    },
    {
      id: "mcp-tools",
      title: "Authenticated Tools (59+)",
      searchTerms: ["tools", "proxy", "balance", "usage", "agentic", "teams", "sessions", "mcp tools"],
      content: [
        { type: "text", text: "When DOMINUSNODE_API_KEY is set, all 59 authenticated tools are available:" },
        {
          type: "param-table", params: [
            { name: "get_proxy_config", type: "proxy", required: false, description: "Get HTTP/SOCKS5 proxy endpoint and credentials" },
            { name: "proxied_fetch", type: "proxy", required: false, description: "Make an HTTP request through the proxy (GET/HEAD/OPTIONS only)" },
            { name: "list_sessions", type: "proxy", required: false, description: "View active proxy sessions" },
            { name: "check_balance", type: "wallet", required: false, description: "Get current wallet balance" },
            { name: "topup_stripe", type: "wallet", required: false, description: "Create Stripe checkout for top-up" },
            { name: "topup_paypal", type: "wallet", required: false, description: "Create PayPal top-up order" },
            { name: "topup_crypto", type: "wallet", required: false, description: "Create crypto invoice (BTC/ETH/SOL/XMR/ZEC/USDC/USDT/DAI/BNB/LINK/LTC)" },
            { name: "check_payment", type: "wallet", required: false, description: "Check crypto invoice payment status" },
            { name: "check_usage", type: "usage", required: false, description: "Get usage statistics for date range" },
            { name: "list_api_keys", type: "keys", required: false, description: "List API keys" },
            { name: "create_api_key", type: "keys", required: false, description: "Create a new API key" },
            { name: "revoke_api_key", type: "keys", required: false, description: "Revoke an API key by ID" },
            { name: "create_agentic_wallet", type: "agentic", required: false, description: "Create an agentic sub-wallet" },
            { name: "fund_agentic_wallet", type: "agentic", required: false, description: "Fund agentic wallet from main wallet" },
            { name: "check_agentic_balance", type: "agentic", required: false, description: "Get agentic wallet balance" },
            { name: "list_agentic_wallets", type: "agentic", required: false, description: "List all agentic wallets" },
            { name: "freeze_agentic_wallet", type: "agentic", required: false, description: "Freeze an agentic wallet" },
            { name: "unfreeze_agentic_wallet", type: "agentic", required: false, description: "Unfreeze an agentic wallet" },
            { name: "delete_agentic_wallet", type: "agentic", required: false, description: "Delete agentic wallet and refund balance" },
            { name: "create_team", type: "teams", required: false, description: "Create a new team" },
            { name: "list_teams", type: "teams", required: false, description: "List teams you belong to" },
            { name: "team_details", type: "teams", required: false, description: "Get team info and member list" },
            { name: "team_fund", type: "teams", required: false, description: "Fund team wallet from personal wallet" },
            { name: "team_create_key", type: "teams", required: false, description: "Create a team API key" },
            { name: "team_usage", type: "teams", required: false, description: "Get team usage statistics" },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 7: AI Integrations
// ---------------------------------------------------------------------------

const aiIntegrations: DocSection = {
  id: "ai-integrations",
  title: "AI Integrations",
  icon: "🧠",
  subsections: [
    {
      id: "ai-langchain",
      title: "LangChain",
      searchTerms: ["langchain", "python", "tools", "llm", "chain", "agent"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "pip install dominusnode-langchain" },
        { type: "code", lang: "python", label: "Usage", code: `from dominusnode_langchain import DominusNodeToolkit
from langchain.agents import initialize_agent

toolkit = DominusNodeToolkit(api_key="dn_live_...")
tools = toolkit.get_tools()  # Returns 7 LangChain BaseTool instances

agent = initialize_agent(tools, llm, agent="zero-shot-react-description")
agent.run("Check my proxy balance and fetch https://httpbin.org/ip")` },
      ],
    },
    {
      id: "ai-crewai",
      title: "CrewAI",
      searchTerms: ["crewai", "crew", "agent", "multi-agent", "python"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "pip install dominusnode-crewai" },
        { type: "code", lang: "python", label: "Usage", code: `from dominusnode_crewai import DominusNodeToolkit
from crewai import Agent, Task, Crew

toolkit = DominusNodeToolkit(api_key="dn_live_...")
proxy_agent = Agent(
    role="Proxy Manager",
    goal="Manage proxy usage and billing",
    tools=toolkit.get_tools()
)` },
      ],
    },
    {
      id: "ai-vercel",
      title: "Vercel AI SDK",
      searchTerms: ["vercel", "ai sdk", "typescript", "generatetext", "streaming", "tool"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/ai-tools" },
        { type: "code", lang: "typescript", label: "Usage", code: `import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { getDominusNodeTools } from '@dominusnode/ai-tools';

const tools = getDominusNodeTools({ apiKey: process.env.DOMINUSNODE_API_KEY });

const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Check my proxy balance and fetch httpbin.org/ip',
});` },
      ],
    },
    {
      id: "ai-openai-functions",
      title: "OpenAI Functions",
      searchTerms: ["openai", "functions", "json schema", "function calling", "gemini", "mistral"],
      content: [
        { type: "text", text: "Cross-platform JSON function schemas that work with OpenAI, Claude, Gemini, Mistral, and any function-calling LLM." },
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/openai-functions\n# or: pip install dominusnode-openai" },
        { type: "code", lang: "javascript", label: "Usage (Node.js)", code: `import { functions, handleFunction } from '@dominusnode/openai-functions';
import OpenAI from 'openai';

const openai = new OpenAI();
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Check my proxy balance' }],
  tools: functions.map(f => ({ type: 'function', function: f })),
});

// Handle tool calls
const toolCall = response.choices[0].message.tool_calls?.[0];
if (toolCall) {
  const result = await handleFunction(toolCall.function.name, JSON.parse(toolCall.function.arguments));
}` },
      ],
    },
    {
      id: "ai-mcp-tools",
      title: "OpenClaw & MCP-Compatible",
      searchTerms: ["openclaw", "mcp plugin", "skill", "typescript", "runtime"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/openclaw-plugin" },
        { type: "code", lang: "typescript", label: "Usage", code: `import { plugin } from '@dominusnode/openclaw-plugin';
// 26 tools with network security controls, OFAC compliance, and safe credential handling
// Register plugin with your OpenClaw-compatible runtime` },
      ],
    },
    {
      id: "ai-gemini",
      title: "Gemini / Vertex AI",
      searchTerms: ["gemini", "vertex ai", "google", "function declaration", "python"],
      content: [
        { type: "code", lang: "python", label: "Usage", code: `from dominusnode_gemini import get_function_declarations, handle_function_call
import google.generativeai as genai

declarations = get_function_declarations()  # 24 FunctionDeclaration objects

model = genai.GenerativeModel('gemini-1.5-pro', tools=declarations)
response = model.generate_content("Check my proxy balance")

if response.candidates[0].content.parts[0].function_call:
    fc = response.candidates[0].content.parts[0].function_call
    result = await handle_function_call(fc.name, dict(fc.args))` },
      ],
    },
    {
      id: "ai-n8n",
      title: "n8n",
      searchTerms: ["n8n", "workflow", "automation", "low-code", "node", "trigger"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install n8n-nodes-dominusnode" },
        { type: "text", text: "Adds 3 custom n8n nodes: Dominus Node Proxy (fetch via proxy), Dominus Node Wallet (balance/topup), and Dominus Node Keys (create/list/revoke). Supports Dominus Node credentials type for secure API key storage." },
      ],
    },
    {
      id: "ai-flowise",
      title: "Flowise",
      searchTerms: ["flowise", "langchain", "dynamic tool", "no-code", "visual"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/flowise-tools" },
        { type: "code", lang: "typescript", label: "Usage", code: `import { DominusNodeToolkit } from '@dominusnode/flowise-tools';

const toolkit = new DominusNodeToolkit({ apiKey: 'dn_live_...' });
const tools = toolkit.getTools(); // 26 DynamicStructuredTool instances` },
      ],
    },
    {
      id: "ai-mastra",
      title: "Mastra",
      searchTerms: ["mastra", "createtool", "typescript", "agent", "workflow"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "npm install @dominusnode/mastra-tools" },
        { type: "code", lang: "typescript", label: "Usage", code: `import { DominusNodeToolkit } from '@dominusnode/mastra-tools';

const toolkit = new DominusNodeToolkit({ apiKey: 'dn_live_...' });
const tools = toolkit.getTools(); // 26 Mastra createTool() instances` },
      ],
    },
    {
      id: "ai-llamaindex",
      title: "LlamaIndex",
      searchTerms: ["llamaindex", "rag", "python", "base tool spec", "function tool"],
      content: [
        { type: "code", lang: "bash", label: "Install", code: "pip install dominusnode-llamaindex" },
        { type: "code", lang: "python", label: "Usage", code: `from dominusnode_llamaindex import DominusNodeToolSpec
from llama_index.core.agent import ReActAgent

spec = DominusNodeToolSpec(api_key="dn_live_...")
tools = spec.to_tool_list()  # 24 FunctionTool instances
agent = ReActAgent.from_tools(tools)` },
      ],
    },
    {
      id: "ai-chatgpt",
      title: "ChatGPT GPT Actions",
      searchTerms: ["chatgpt", "gpt actions", "openapi", "ai plugin", "custom gpt"],
      content: [
        { type: "text", text: "Use the Dominus Node OpenAPI 3.1.0 spec to configure a ChatGPT Custom GPT with Actions. The GPT can call the Dominus Node REST API directly — checking balances, managing API keys, and triggering top-ups from within a conversation." },
        { type: "note", variant: "info", text: "In your Custom GPT settings, add a new Action and paste in the Dominus Node OpenAPI schema URL. Set the authentication type to 'API Key' and use your Dominus Node API key as the bearer token." },
      ],
    },
    {
      id: "ai-others",
      title: "Other Frameworks",
      searchTerms: ["autogpt", "agent zero", "pydantic", "camel", "metagpt", "superagi", "agno", "semantic kernel", "ironclaw", "haystack", "composio", "dify", "langflow", "taskweaver", "moltbook"],
      content: [
        { type: "text", text: "Dominus Node also integrates with these frameworks — each with full SSRF protection and OFAC validation:" },
        {
          type: "param-table", params: [
            { name: "AutoGPT", type: "Python", required: false, description: "pip install dominusnode-autogpt — command plugin with 22 functions" },
            { name: "Agent Zero", type: "Python", required: false, description: "pip install dominusnode-agent-zero — numbered tool modules (01-04)" },
            { name: "PydanticAI", type: "Python", required: false, description: "pip install dominusnode-pydanticai — async typed tool functions" },
            { name: "CAMEL-AI", type: "Python", required: false, description: "pip install dominusnode-camel — FunctionTool objects for multi-agent" },
            { name: "MetaGPT", type: "Python", required: false, description: "pip install dominusnode-metagpt — DataInterpreter compatible" },
            { name: "SuperAGI", type: "Python", required: false, description: "pip install dominusnode-superagi — registered toolkit" },
            { name: "Agno", type: "Python", required: false, description: "pip install dominusnode-agno — x402 + agentic wallet support" },
            { name: "Semantic Kernel", type: "Python", required: false, description: "pip install dominusnode-sk — Microsoft SK native plugin (25 functions)" },
            { name: "IronClaw", type: "Python", required: false, description: "pip install dominusnode-ironclaw — NEAR AI with MCP bridge" },
            { name: "Haystack", type: "Python", required: false, description: "pip install dominusnode-haystack — Pipeline component" },
            { name: "Composio", type: "TypeScript", required: false, description: "npm install @dominusnode/composio — Action toolkit" },
            { name: "Dify", type: "Python", required: false, description: "pip install dominusnode-dify — Dify tool provider" },
            { name: "Langflow", type: "Python", required: false, description: "pip install dominusnode-langflow — Custom Langflow component" },
            { name: "n8n", type: "TypeScript", required: false, description: "npm install n8n-nodes-dominusnode — 3 custom nodes + credential type" },
            { name: "Mastra", type: "TypeScript", required: false, description: "npm install @dominusnode/mastra-tools — 26 createTool() instances" },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 8: x402 Protocol
// ---------------------------------------------------------------------------

const x402Protocol: DocSection = {
  id: "x402-protocol",
  title: "x402 Protocol",
  icon: "💳",
  subsections: [
    {
      id: "x402-overview",
      title: "How x402 Works",
      searchTerms: ["x402", "402", "http 402", "micropayment", "usdc", "pay per request", "on-chain"],
      content: [
        { type: "text", text: "x402 is an HTTP-native micropayment protocol. When an agent makes a proxy request without credentials, it receives an HTTP 402 response with USDC payment requirements. The agent pays on-chain, attaches the receipt, and the request is served." },
        {
          type: "param-table", params: [
            { name: "Step 1", type: "HTTP", required: true, description: "Client sends request → server returns 402 with X-Payment-Requirements header" },
            { name: "Step 2", type: "On-chain", required: true, description: "Client transfers USDC to Dominus Node wallet address on specified chain" },
            { name: "Step 3", type: "HTTP", required: true, description: "Client resends request with X-Payment header (tx hash + signature)" },
            { name: "Step 4", type: "HTTP", required: true, description: "Server verifies payment on-chain, proxies request, returns response" },
          ],
        },
        { type: "note", variant: "info", text: "x402 requires no account or API key — AI agents pay directly from their crypto wallet. Useful for fully autonomous agents." },
      ],
    },
    {
      id: "x402-networks",
      title: "Supported Networks",
      searchTerms: ["coinbase", "payai", "base", "solana", "polygon", "avalanche", "sei", "skale", "iotex", "xlayer", "peaq"],
      content: [
        { type: "text", text: "Dominus Node supports x402 payments on 9 chains via two facilitators:" },
        {
          type: "param-table", params: [
            { name: "Base", type: "Coinbase", required: false, description: "EIP-3009 gasless USDC transfer. Network ID: 'base'" },
            { name: "Base Sepolia", type: "Coinbase", required: false, description: "Testnet. Network ID: 'base-sepolia'" },
            { name: "Solana", type: "PayAI", required: false, description: "~400ms settlement. Network ID: 'solana'" },
            { name: "Polygon", type: "PayAI", required: false, description: "PoS sidechain. Network ID: 'polygon'" },
            { name: "Avalanche", type: "PayAI", required: false, description: "C-Chain EVM. Network ID: 'avalanche'" },
            { name: "Sei", type: "PayAI", required: false, description: "High-speed EVM. Network ID: 'sei'" },
            { name: "SKALE", type: "PayAI", required: false, description: "Zero gas fees. Network ID: 'skale-base'" },
            { name: "IoTeX", type: "PayAI", required: false, description: "DePIN network. Network ID: 'iotex'" },
            { name: "XLayer", type: "PayAI", required: false, description: "OKX L2. Network ID: 'xlayer'" },
            { name: "Peaq", type: "PayAI", required: false, description: "DePIN L1. Network ID: 'peaq'" },
          ],
        },
      ],
    },
    {
      id: "x402-client",
      title: "Client Implementation",
      searchTerms: ["client", "x-payment", "x-payment-requirements", "receipt", "nonce", "signature"],
      content: [
        { type: "code", lang: "javascript", label: "x402 client flow (Node.js)", code: `// Step 1: Send request, expect 402
const res = await fetch('https://proxy.dominusnode.com/fetch?url=https://httpbin.org/ip');
if (res.status === 402) {
  const requirements = res.headers.get('X-Payment-Requirements');
  const req = JSON.parse(requirements);
  // req.network, req.asset (USDC address), req.payTo, req.maxAmountRequired

  // Step 2: Sign & broadcast USDC transfer
  const receipt = await yourWallet.signAndSendUsdcTransfer({
    to: req.payTo,
    amount: req.maxAmountRequired,
    network: req.network,
    nonce: req.nonce,
  });

  // Step 3: Retry with payment receipt
  const paid = await fetch('https://proxy.dominusnode.com/fetch?url=https://httpbin.org/ip', {
    headers: { 'X-Payment': JSON.stringify(receipt) },
  });
}` },
        { type: "note", variant: "info", text: "x402 supports read-only requests (GET, HEAD, OPTIONS). For authenticated write operations, use a standard Dominus Node API key with your wallet balance." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 9: Plans & Billing
// ---------------------------------------------------------------------------

const plansBilling: DocSection = {
  id: "plans-billing",
  title: "Plans & Billing",
  icon: "💰",
  subsections: [
    {
      id: "billing-plans",
      title: "Available Plans",
      searchTerms: ["free", "payg", "volume", "100gb", "1tb", "agent", "plan", "pricing", "gb"],
      content: [
        { type: "text", text: "Dominus Node offers tiered plans with per-GB pricing. All plans use the same prepaid wallet system." },
        {
          type: "param-table", params: [
            { name: "Free DC", type: "Plan", required: false, description: "$0/GB — 490 MB datacenter bandwidth, 5 connections. Free forever." },
            { name: "Free Residential", type: "Plan", required: false, description: "$0/GB — 50 MB residential bandwidth, 5 connections. Free forever." },
            { name: "Pay As You Go", type: "Plan", required: false, description: "$5.00/GB residential — unlimited bandwidth, 100 connections." },
            { name: "Volume 100GB", type: "Plan", required: false, description: "$4.00/GB — 100 GB/month included, 100 connections." },
            { name: "Volume 1TB", type: "Plan", required: false, description: "$3.00/GB — 1 TB/month included, 100 connections. Best value." },
            { name: "AI Agent", type: "Plan", required: false, description: "$5.00/GB — Optimized for AI agents, 50 connections, agentic wallet support." },
          ],
        },
        { type: "note", variant: "info", text: "DC pool is always $3.00/GB regardless of plan. Residential pool pricing varies by plan. No credit card required for free plans." },
      ],
    },
    {
      id: "billing-wallet",
      title: "Wallet System",
      searchTerms: ["wallet", "balance", "prepaid", "credits", "cents", "cap", "maximum"],
      content: [
        { type: "text", text: "Dominus Node uses a prepaid credit wallet. Usage is debited from your balance automatically." },
        {
          type: "param-table", params: [
            { name: "Balance format", type: "integer cents", required: true, description: "API responses return balance as an integer number of cents — divide by 100 for the dollar amount (e.g., 1000 = $10.00)" },
            { name: "Minimum session", type: "$0.50", required: true, description: "$0.50 reservation required to open a new proxy session" },
            { name: "Maximum balance", type: "$100.00", required: true, description: "Application-level cap of $100.00 (10,000 cents) per wallet" },
            { name: "Overspend protection", type: "guaranteed", required: true, description: "Your balance can never go below $0.00 — all transactions are validated before they are processed" },
          ],
        },
      ],
    },
    {
      id: "billing-payment-methods",
      title: "Payment Methods",
      searchTerms: ["stripe", "paypal", "crypto", "bitcoin", "ethereum", "usdc", "nowpayments", "card", "link"],
      content: [
        { type: "heading", level: 3, text: "Stripe (Card + Link)" },
        { type: "text", text: "Credit/debit card via Stripe Checkout. Stripe Link enables one-click checkout for returning customers. All major card networks supported." },
        { type: "code", lang: "bash", code: `curl -X POST https://api.dominusnode.com/api/wallet/topup/stripe \\
  -H 'Authorization: Bearer eyJ...' \\
  -d '{"amountCents": 2000}'
# → { "sessionId": "cs_...", "url": "https://checkout.stripe.com/..." }` },
        { type: "heading", level: 3, text: "PayPal (Direct Integration)" },
        { type: "text", text: "Lower fees than card. Supports PayPal balance, linked bank account, and PayPal credit. Two-step: create order → capture after approval." },
        { type: "heading", level: 3, text: "NOWPayments (11 Cryptocurrencies)" },
        {
          type: "param-table", params: [
            { name: "BTC", type: "Bitcoin", required: false, description: "Bitcoin — standard on-chain" },
            { name: "ETH", type: "Ethereum", required: false, description: "Ethereum Mainnet" },
            { name: "SOL", type: "Solana", required: false, description: "Fast settlement" },
            { name: "XMR", type: "Monero", required: false, description: "Privacy coin — anonymous billing" },
            { name: "ZEC", type: "Zcash", required: false, description: "Privacy coin — shielded transactions" },
            { name: "USDC", type: "USD Coin", required: false, description: "Stable, on-chain fiat equivalent" },
            { name: "USDT", type: "Tether", required: false, description: "Stable, widely accepted" },
            { name: "DAI", type: "Dai", required: false, description: "Decentralized stablecoin" },
            { name: "BNB", type: "BNB Chain", required: false, description: "Binance Smart Chain" },
            { name: "LINK", type: "Chainlink", required: false, description: "Oracle network token" },
            { name: "LTC", type: "Litecoin", required: false, description: "Fast, low-fee Bitcoin alternative" },
          ],
        },
        { type: "note", variant: "info", text: "Minimum crypto top-up: $5.00. Payments auto-convert to wallet credits via NOWPayments." },
      ],
    },
    {
      id: "billing-agentic",
      title: "Agentic Wallets",
      searchTerms: ["agentic", "agent", "sub-wallet", "spending limit", "custodial", "audit"],
      content: [
        { type: "text", text: "Agentic wallets let you give AI agents controlled spending authority without exposing your main wallet." },
        { type: "code", lang: "javascript", label: "Create and fund an agentic wallet", code: `const client = new DominusNodeClient({ apiKey: 'dn_live_...' });

// Create with $5 per-transaction limit
const wallet = await client.agenticWallet.create({
  label: 'scraper-agent-1',
  spendingLimitCents: 500,  // $5.00 max per spend
});

// Fund it with $20
await client.agenticWallet.fund(wallet.id, { amountCents: 2000 });

// Agent uses walletId as its spending identity
// Freeze if compromised
await client.agenticWallet.freeze(wallet.id);` },
        {
          type: "param-table", params: [
            { name: "spendingLimitCents", type: "integer", required: true, description: "Maximum spend allowed per transaction, enforced server-side for every debit against this wallet." },
            { name: "Maximum balance", type: "$100.00", required: true, description: "Same cap as main wallet — maximum $100.00 per agentic wallet." },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Section 10: Security & Compliance
// ---------------------------------------------------------------------------

const securityCompliance: DocSection = {
  id: "security-compliance",
  title: "Security & Compliance",
  icon: "🛡️",
  subsections: [
    {
      id: "sec-key-rotation",
      title: "Key Rotation",
      searchTerms: ["key rotation", "revoke", "rotate", "api key", "compromised"],
      content: [
        { type: "text", text: "Rotate API keys at any time from the dashboard or via API. Old keys are immediately revoked — active proxy sessions using that key will be terminated." },
        { type: "code", lang: "bash", code: `# Revoke old key
curl -X DELETE https://api.dominusnode.com/api/keys/KEY_ID \\
  -H 'Authorization: Bearer eyJ...'

# Create replacement
curl -X POST https://api.dominusnode.com/api/keys \\
  -H 'Authorization: Bearer eyJ...' \\
  -d '{"label":"rotated-key"}'` },
        { type: "note", variant: "tip", text: "Prefix the first 8 characters of your key in logs (never more). Full keys should never appear in logs or error messages." },
      ],
    },
    {
      id: "sec-ssrf",
      title: "Network Access Controls",
      searchTerms: ["ssrf", "server side request forgery", "private ip", "localhost", "dns rebinding", "internal", "network security"],
      content: [
        { type: "text", text: "Every proxy destination is validated server-side before any traffic is forwarded. Dominus Node enforces strict network access controls to protect both our infrastructure and the targets you reach." },
        {
          type: "param-table", params: [
            { name: "Private networks", type: "blocked", required: false, description: "Requests to private IP ranges (RFC 1918), loopback, link-local, CGNAT, and multicast addresses are rejected" },
            { name: "Internal hostnames", type: "blocked", required: false, description: "Destinations like .local, .internal, and .localhost are blocked — your traffic only exits to public internet addresses" },
            { name: "Cloud metadata endpoints", type: "blocked", required: false, description: "Cloud provider instance metadata services (169.254.169.254 etc.) are unconditionally blocked" },
            { name: "Encoded bypass attempts", type: "normalized & blocked", required: false, description: "Alternate IP representations (hex, octal, decimal integers, IPv6-mapped) are normalized and re-validated before forwarding" },
            { name: "DNS rebinding", type: "mitigated", required: false, description: "Hostnames are resolved and all returned IPs are validated at request time — late binding to a private IP is blocked" },
            { name: "Embedded credentials", type: "stripped", required: false, description: "URLs containing embedded username:password credentials are rejected" },
          ],
        },
        { type: "note", variant: "tip", text: "These controls apply at every layer — the proxy gateway, all AI integration tool calls, and the x402 payment handler." },
      ],
    },
    {
      id: "sec-ofac",
      title: "OFAC Sanctions Compliance",
      searchTerms: ["ofac", "sanctions", "cuba", "iran", "north korea", "russia", "syria", "blocked countries"],
      content: [
        { type: "text", text: "Dominus Node enforces OFAC (Office of Foreign Assets Control) sanctions. Traffic targeting or originating from sanctioned jurisdictions is blocked at all layers." },
        {
          type: "param-table", params: [
            { name: "CU", type: "Cuba", required: false, description: "Blocked — OFAC SDN list" },
            { name: "IR", type: "Iran", required: false, description: "Blocked — OFAC SDN list" },
            { name: "KP", type: "North Korea", required: false, description: "Blocked — OFAC SDN list" },
            { name: "RU", type: "Russia", required: false, description: "Blocked — OFAC SDN list" },
            { name: "SY", type: "Syria", required: false, description: "Blocked — OFAC SDN list" },
          ],
        },
        { type: "note", variant: "danger", text: "Attempting to route traffic to or from OFAC-sanctioned countries will result in request rejection and may trigger account review." },
      ],
    },
    {
      id: "sec-gdpr",
      title: "GDPR Compliance",
      searchTerms: ["gdpr", "data export", "right to erasure", "deletion", "article 17", "article 20", "privacy"],
      content: [
        { type: "text", text: "Dominus Node is GDPR compliant. Exercise your rights:" },
        { type: "code", lang: "bash", label: "Export all personal data (Article 20)", code: `curl https://api.dominusnode.com/api/gdpr/export \\
  -H 'Authorization: Bearer eyJ...'
# → JSON with all user data, usage history, wallet transactions, API keys, sessions` },
        { type: "code", lang: "bash", label: "Delete all data (Article 17)", code: `curl -X DELETE https://api.dominusnode.com/api/gdpr/delete \\
  -H 'Authorization: Bearer eyJ...'
# All data permanently deleted within 24 hours` },
        { type: "note", variant: "warning", text: "Account deletion is irreversible. All wallet balance is forfeited. Export your data first if needed." },
      ],
    },
    {
      id: "sec-rate-limits",
      title: "Rate Limits",
      searchTerms: ["rate limit", "429", "throttle", "abuse", "limits"],
      content: [
        {
          type: "param-table", params: [
            { name: "Login", type: "5/15min per IP", required: false, description: "Brute-force protection on /api/auth/login" },
            { name: "Register", type: "3/hour per IP", required: false, description: "Account creation rate limit" },
            { name: "Wallet verify", type: "10/15min per IP", required: false, description: "EIP-191 wallet verification" },
            { name: "Promo redeem", type: "5/hour per user", required: false, description: "Promo code redemption attempts" },
            { name: "Crypto status", type: "30/min per user", required: false, description: "Invoice status polling" },
            { name: "Invite accept", type: "10/hour per IP", required: false, description: "Team invite acceptance" },
          ],
        },
        { type: "note", variant: "info", text: "AI agents using the MCP server are automatically exempt from browser-based verification but are still subject to the same rate limits as any other client." },
      ],
    },
    {
      id: "sec-mfa-tokens",
      title: "Session & Token Security",
      searchTerms: ["session", "token", "jwt", "refresh", "mfa", "cookie", "httponly", "secure"],
      content: [
        {
          type: "param-table", params: [
            { name: "JWT access token", type: "15 min expiry", required: true, description: "Short-lived bearer token for API calls" },
            { name: "Refresh token", type: "7 day expiry, rotating", required: true, description: "Rotates on every use — reusing an old token immediately invalidates all active sessions" },
            { name: "MFA challenge token", type: "5 min, single-use", required: true, description: "Issued after password check; used once to complete MFA verification" },
            { name: "Cookie auth", type: "HttpOnly + Secure + SameSite=Lax", required: true, description: "Web client auth via secure cookies" },
            { name: "CSRF protection", type: "Origin header validation", required: true, description: "Requests to cookie-based auth endpoints are validated against the expected origin" },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const DOC_SECTIONS: DocSection[] = [
  quickStart,
  authentication,
  proxyUsage,
  apiReference,
  sdkReference,
  mcpServer,
  aiIntegrations,
  x402Protocol,
  plansBilling,
  securityCompliance,
];
