# @dominusnode/pool-manager

Team: **Core Platform**

Manages Webshare dual-pool upstream (DC + residential) with geo targeting and sticky sessions.

## Key Files
- `src/webshare.ts` — Webshare config, proxy URL builder, bandwidth API
- `src/webshare-provider.ts` — WebshareDCProvider + WebshareResidentialProvider
- `src/index.ts` — Re-exports

## Rules
- Webshare endpoint: p.webshare.io:80 (HTTP) / :1080 (SOCKS5)
- DC and Residential use separate credentials (different env vars)
- Bandwidth caps: DC 1TB, Residential 10GB hard caps (monitoring/alerting needed)
- Never expose upstream Webshare credentials to end users
