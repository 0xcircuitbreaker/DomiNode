# DominusNode launch plan (drafted 2026-11-06)

Status: draft for the owner. Nothing here is committed. Sources are cited inline; secondary sources are marked "(secondary)" and should be re-checked before relying on exact numbers.

Read with: DESIGN.md §15 (tiers, payouts, rollout gates), ECONOMICS.md (pricing, margins), ABUSE_CONTROLS.md, PAYMENTS.md, DEPLOYMENT.md.

## 0. The problem in one paragraph

DominusNode is two-sided: buyers (agents that need exit IPs) only come if there are healthy nodes in useful countries, and contributors (agents running `packages/node-agent`) only stay if paid traffic reaches them. Payouts (`PAYOUTS_ENABLED`) are off until counsel signs off (DESIGN.md §15), so early node earnings are credits that can be converted into requester balance but not cashed out. The plan therefore **supplies the first side ourselves** (operator-run seed nodes, which DESIGN.md §11/§12.3 already assumes) and **sells demand on price, privacy and zero-signup x402**, then opens supply to outside contributors once there is paid traffic to share.

## 1. Lessons from bandwidth / DePIN networks

| Network | What bootstrapped it | What went wrong / lesson |
|---|---|---|
| Grass | Points-for-uptime, a 3-level referral (20%/10%/5% of referees' points, later flat bonuses) and a 10% token airdrop (100M GRASS), later 17% (https://depinhub.io/blog/grass-referral-program/, https://coinmarketcap.com/academy/article/how-to-claim-the-grass-airdrop-a-comprehensive-guide, secondary) | Mass multi-accounting. Grass resets sybil accounts to zero (https://9o1hbtdj3x-stg.depinhub.io/blog/improvements-to-the-grass-points-system). Speculative "farmers" leave when the incentive ends. **Lesson:** reward only *paid, matured traffic from other principals*. Our tier rules already do this (ECONOMICS.md anti-gaming rules 1–3). Do not adopt multi-level referrals. |
| Honeygain / PacketStream | Cash payouts per GB (PacketStream about $0.10/GB, ECONOMICS.md §1) plus referral bonuses | Low pay and $20+ payout minimums create churn. Proxy-SDK monetisation of apps drags the category's reputation down (see IPIDEA below). **Lesson:** our pitch is higher pay per GB, USDC, and no $20 minimum (ECONOMICS.md). It only holds once payouts are legal. |
| Helium | Token rewards for *deploying* hotspots | Widespread location spoofing and emulated hotspots, and rewards for deployment rather than usage led to speculative clusters and an underused network (https://simeononsecurity.com/other/how-to-game-on-the-helium-network/, https://www.chainscorelabs.com/blog/blockchain-and-iot-the-machine-economy/decentralized-wireless-networks/why-proof-of-coverage-fails-as-a-depin-network-metric, secondary). **Lesson:** never pay for "being online"; uptime must be measured at the gateway (already true: ECONOMICS.md rule 3) and earnings must follow buyer bytes. |
| Mysterium / Wynd | Node-operator token rewards plus a consumer VPN as first demand | Supply outran demand: the operators who earn are the ones in demanded geos. **Lesson:** gate outside supply on demand ("waitlist by country/ASN") instead of letting everyone in on day one. |
| IPIDEA, 911 S5, NetNut/Popa | Residential IPs collected through SDKs embedded in third-party apps, malware or free VPNs | Google disrupted IPIDEA in January 2026: C2 and domain takedowns, Play Protect removing apps with its SDKs, over 550 threat groups seen using it in one week (https://www.bleepingcomputer.com/news/security/google-disrupts-ipidea-residential-proxy-networks-fueled-by-malware/amp/, https://securityaffairs.com/187463/security/google-targets-ipidea-in-crackdown-on-global-residential-proxy-networks). The FBI dismantled 911 S5, about 19M IPs (https://en.wikipedia.org/wiki/Ipidea, secondary), and NetNut-related domains were seized in 2026 (secondary). **Lesson:** see §4.3. Any bundled node-ware or paid-install supply gets you delisted, drops payment rails, and is legal exposure for the owner. |

## 2. Where agents and their developers discover tools

| # | Directory / channel | How to list | Requirements | Effort | Owner |
|---|---|---|---|---|---|
| 1 | Official MCP Registry (registry.modelcontextprotocol.io) | `mcp-publisher init` → `login github` → `publish` (https://composio.dev/blog/how-to-publish-mcp-server, https://learn.microsoft.com/en-us/dotnet/ai/quickstarts/publish-mcp-registry) | npm package published first; `"mcpName"` in `packages/mcp-server/package.json` (**missing today**); a `server.json` in the registry schema (the existing `mcp-server.json` is a custom format); namespace `io.github.<owner>/…` or a DNS-verified `com.dominusnode/…`. Registry is a preview service with no review. | 1–2 h | Owner |
| 2 | Smithery (smithery.ai) | Add `smithery.yaml` or submit at smithery.ai; reportedly also ingests the official registry (https://coding-dev-tools.github.io/devforge/blog/mcp-server-directories-where-to-list-your-server.html, secondary) | Check whether a hosted remote endpoint is required | 1–2 h | Owner |
| 3 | Glama (glama.ai/mcp/servers) | GitHub sign-in, browser submission; quality score weighs license, CI, SECURITY.md and tool descriptions (same source, secondary) | Public repo with LICENSE, SECURITY.md and CI badge | 1 h | Owner |
| 4 | PulseMCP | Auto-indexes from the official registry; manual submit form as fallback | Registry listing | 0.5 h | Owner |
| 5 | mcp.so | "Submit" button / GitHub issue on its repo (https://dev.to/vdalhambra/from-0-to-27-directories-in-1-week-the-honest-mcp-distribution-playbook-2497, secondary) | README with install config | 0.5 h | Owner |
| 6 | awesome-mcp-servers (punkpeye) | One-line PR in the right category | Honest one-liner, no superlatives | 0.5 h | Owner |
| 7 | Docker MCP Catalog | PR to docker/mcp-registry | Dockerfile for the MCP server | 3 h | Owner |
| 8 | x402 Bazaar (Coinbase CDP) | Automatic once a resource has settled through the CDP facilitator with the Bazaar extension and `paymentPayload.resource` set; check first with the validate endpoint (https://docs.cdp.coinbase.com/x402/seller/get-discovered, https://docs.cdp.coinbase.com/x402/validate-endpoint) | Gateway x402 rail on CDP facilitator with discovery metadata (description, input/output schema) | 0.5 day (verify the gateway emits the Bazaar extension) | Owner + Billing |
| 9 | Agentic.Market (Coinbase) | Service listing built on Bazaar (https://www.coinbase.com/developer-platform/discover/launches/agentic-market) | Bazaar-indexed resource | 1 h | Owner |
| 10 | Other x402 catalogs (x402.org facilitator, PayAI) | Each facilitator has its own catalog (https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer) | Settle through them | 1 h each | Owner |
| 11 | Stripe machine-payments / MPP directory | Stripe docs list x402 and MPP side by side (https://forklog.com/en/stripe-and-tempo-launch-mainnet-for-ai-agent-payments/) | MPP rail live (PAYMENTS.md); ask the Stripe/Tempo partner contact for directory inclusion | 1 day | Owner |
| 12 | npm / PyPI / crates.io / Go / Maven / vcpkg | Publish SDKs v2 and the 27 integrations under consistent names, with keywords `mcp`, `proxy`, `ai-agent`, `x402` | Release workflow (`.github/workflows/release.yml`, `scripts/release/`) | 1 day | Owner |
| 13 | LangChain integrations docs | PR to the langchain docs "integrations/tools" page, pointing to `integrations/langchain` on PyPI | Docs page with a working notebook | 0.5 day | Owner |
| 14 | LlamaHub / LlamaIndex | Publish `llama-index-tools-dominusnode` on PyPI, then a PR | Package naming convention | 0.5 day | Owner |
| 15 | CrewAI tools | Community tool PR or a docs listing | Example crew | 0.5 day | Owner |
| 16 | n8n community nodes | Publish `n8n-nodes-dominusnode` on npm (`n8n-community-node-package` keyword); optional verification submission | n8n lint passes | 0.5 day | Owner |
| 17 | Composio, Mastra, Vercel AI SDK, Dify, Flowise, Langflow marketplaces | Each has a toolkit/plugin submission flow; `integrations/` already contains all of these | Per-framework README and example | 2 h each | Owner |
| 18 | OpenAI GPT store / ChatGPT apps, Claude connector directory | Only when a remote (HTTP) MCP endpoint with OAuth exists | Remote MCP server (not built) | later | Owner |

Do this honestly: one listing per directory, accurate descriptions (state that it is alpha, that payouts are not live, and that plaintext HTTP is visible to the exit), no review-swapping, no star-buying.

## 3. Demand niches and competitors

**Where agents need IPs today:** research and scraping agents fetching public pages that geo-block or rate-limit DC ranges; browser agents (Browserbase/Playwright stacks) that need a residential egress; price and availability monitoring by country; SEO/SERP and ad-verification checks by geography; QA and geo-testing of one's own sites (localized content, CDNs, geo-fenced flows); app-store and marketplace localization checks.

**Competitor agent offerings:**
- Bright Data MCP: free tier of 5,000 requests/month drawn from the shared Web Unlocker pool; browser tools are paid; API token only (https://docs.brightdata.com/mcp-server/faqs, https://brightdata.com/pricing/mcp-server). Residential at $8/GB list, $4/GB promo (ECONOMICS.md).
- Oxylabs, Decodo/Smartproxy, Zyte, Apify, Firecrawl: MCP servers and scraper APIs (verify current pricing before quoting).
- Browserbase/Steel/Hyperbrowser: hosted browsers whose proxies are add-ons. **These are partners, not only competitors:** DominusNode is the egress, they are the browser.
- DataImpulse $1/GB and PacketStream $1/GB residential are the price floor (ECONOMICS.md §1).

**Differentiation (all claims must match what ships):**
1. Price: $0.50/GB residential, $0.20/GB dc, no minimum, credit never expires.
2. Zero signup: x402/MPP per request. An agent with a USDC wallet pays and fetches, with no account or key.
3. Privacy floor: HTTPS stays end-to-end TLS to the exit, there is no payload logging, `/v1/policy` is public with a version hash, and SSRF protection in the node cannot be switched off (ABUSE_CONTROLS.md).
4. Agent-native: 65-tool MCP server, 6 SDKs and 27 integrations, plus the ability to *earn* by contributing an IP. No incumbent offers a two-way agent market.
5. Ethically sourced supply: every IP is a consenting, attested operator (control #1). Given the IPIDEA/NetNut takedowns, this matters to buyers' compliance teams.

Weaknesses to be honest about: small pool at launch, fewer countries, no unblocker or CAPTCHA solving, alpha reliability.

## 4. Supply bootstrap

### 4.1 Seed fleet (Phase 1)

The rollout gates already exist: smoke gate of at least 3 nodes for 2 h, then the production soak gate of at least 20 nodes for 72 h (DESIGN.md §15). Launch with headroom:

| Segment | Count | Where | Est. cost/month |
|---|---|---|---|
| DC nodes on cheap VPS | 30 | 10 countries (US-East, US-West, CA, BR, GB, DE, NL, FR, PL, SG, JP, IN, AU; no OFAC countries) across ≥8 ASNs (e.g. Hetzner, OVH, DigitalOcean, Vultr, Linode/Akamai, Scaleway, Contabo, AWS Lightsail) | $4–7 each, about $150–220 |
| Residential seed lines | 6–10 | Owner and team homes, or dedicated consumer lines in US, GB, DE, CA, AU, with each line owner signing the contributor attestation | $0 (existing) to $40 each (dedicated line), about $0–400 |
| Mobile seeds | 2–4 | 4G/5G router with a prepaid SIM in US/GB/DE. Check the carrier ToS allows relaying; many forbid it. | $30–60 each, about $60–240 |
| Gateway egress | — | Per ECONOMICS.md, the gateway relays every byte (about 2 GB egress per billed GB), so choose unmetered bandwidth | $50–150 |
| **Total** | **≈40 nodes** | | **≈ $300–1,000/mo** |

Rules for seed nodes:
- Register them under a dedicated platform principal. Their earnings go back to the platform (DESIGN.md §11). They must **not** count toward any outside agent's tier, and the self-dealing filter already excludes platform-to-platform traffic.
- Label them as operator-run in `/v1/network/stats` (publish "N operator seed nodes / M community nodes") so the network doesn't appear more decentralized than it is.
- Never buy residential proxies from another provider and re-sell them as "nodes". That imports their sourcing problems and breaks the attestation promise.
- Retire seed DC nodes in a country once community nodes there pass 3× the seed capacity at Silver tier or above.

### 4.2 Genesis incentives (fit the existing tier and anti-sybil system)

- **Genesis cohort:** the first 200 *beneficial owners* (aggregated per payout wallet, funding source or team, as tier inputs already are) whose nodes carry matured paid traffic from ≥3 distinct paying requesters in their first 30 days.
- **Benefit A, time-limited share boost:** +5 percentage points on top of the tier share for 90 days, capped so the result never exceeds the 5000 bps `CHECK`. Probation becomes 30%, Bronze 35%, and so on. Snapshot it into `relay_charges` at session start, like the tier.
- **Benefit B, demand-gated credit grant:** a one-time $5 credit grant paid only when the node's cumulative *matured, undisputed, other-principal* paid traffic reaches 5 GB, with the normal 14-day Probation maturity hold and clawback. Usable as requester balance now and withdrawable only once payouts are legal.
- **Coverage bonus (later):** a higher share for nodes in countries or ASNs on a published "wanted" list, with the list driven by unfilled buyer requests. Paid on traffic, never on online time.
- **No** multi-level referrals, no points-for-uptime, no airdrop promises, no "early contributors will get tokens". There is no token, and implying one creates securities and consumer-protection risk.
- Node referral codes (if enabled) pay the referrer only a fixed credit after the referee's node has passed the same 5 GB matured-traffic bar, with a cap of 10 per referrer per month and no payout when owner linkage shows the same beneficial owner.

### 4.3 What NOT to do, and why

- **Paid installs or incentivized-install networks:** the users who install don't understand that their IP is shared, which voids the consent attestation (control #1), and these networks are the main malware distribution channel.
- **Bundling node-ware in SDKs, integrations, the browser extension or third-party apps:** this is exactly the proxyware model Google Play Protect now removes, and it is what put IPIDEA and NetNut in takedown actions (citations in §1). Consequences: Play/Chrome store bans (the extension itself would be pulled), Cloudflare and anti-fraud vendors classifying the whole ASN footprint as a proxy botnet, payment-rail and facilitator delisting (ABUSE_CONTROLS.md "Revenue"), CFAA and computer-misuse exposure, and FTC deceptive-practice exposure. **The node agent is always a separate, explicit, opt-in install, and its first-run screen states what is shared.**
- Running nodes on cloud or ISP accounts whose ToS forbid it, or on employer, university or public networks.
- Paying contributors for uptime or for being "registered". Helium showed this produces fake supply.

## 5. Demand bootstrap

1. **x402 / MPP pay-per-request as the default quickstart.** No signup, no key. It is already built (PAYMENTS.md, `packages/billing` rails). Make the first README snippet `npx @dominusnode/mcp-server` in bootstrap mode, plus an x402 curl or SDK example.
2. **Starter credits** (needs building, see §9): $0.50 per new principal (≈1 GB residential or 2.5 GB dc), granted only after (a) wallet-signature auth, (b) the wallet has ≥1 prior on-chain transaction or a $1 top-up, and (c) a per-/24 and per-funding-source cap of 1 grant. A global daily budget of $50 (100 grants a day), adjustable by the admin. Credits expire after 30 days, are never withdrawable, and are excluded from node tier tenure, so they pay nodes but don't promote anyone. Starter-credit traffic only goes to seed nodes in the first month, so community nodes aren't exposed to anonymous free users.
3. **Launch partners (5–10):** agent-framework maintainers and browser-infra companies (Browserbase/Steel-style) that need a cheap residential egress, x402 ecosystem projects (Coinbase CDP/Agentic.Market, the x402 Foundation launched April 2026 with 22 backers, https://machineherald-io.pages.dev/article/2026-04/06-linux-foundation-launches-x402-foundation-with-22-industry-backers-as-ai-agent-payment-infrastructure-takes-shape, secondary), and Tempo/MPP ecosystem builders (MPP launched 2026-03-18, https://thepaypers.com/payments/news/paradigm-and-stripe-launch-machine-payments-protocol-for-ai-agent-transactions). Offer: $100 credit, a shared Slack/Discord channel, priority country requests and co-marketing *with their explicit approval*.
4. **Grants and hackathons:** apply to Base/Coinbase developer grants and x402 or agent-payments hackathons (Base's grant program terms were not confirmed in this research, so verify on base.org). Sponsor a bounty: "best agent using x402 + DominusNode egress", paid in credits.
5. **Docs per framework:** one 10-line quickstart per integration (all 27 exist under `integrations/`), plus three end-to-end examples: geo price check, SERP by country, Playwright browser agent over SOCKS5.
6. **Public status / network-stats page:** nodes online by class, country and ASN count, 24 h success rate, p50/p95 latency, paid GB/day, policy hash and incident history. The data endpoint `/v1/network/stats` exists; the page does not.
7. **Directory listings:** the action table in §2.

## 6. Honest, platform-compliant marketing

- The owner posts, under their own name, on their own accounts. No automated posting or reply bots, no sock puppets, no paid upvotes, no "seeded" testimonials, and no undisclosed incentivized reviews (FTC endorsement guides). The repo already removed a Moltbook engagement bot for exactly this reason. Don't rebuild one, even "just for announcements". (`integrations/moltbook` is a tool integration for agents, not a poster, and should stay that way.)
- Launch posts, each disclosed as "I built this", all at once in launch week:
  - Show HN, following the HN Show rules: something people can try and no vote solicitation.
  - Product Hunt, on a Tuesday–Thursday, with no vote-ring requests.
  - r/mcp, r/LocalLLaMA (the self-promo rules there limit you to one post), r/webscraping (check its self-promo rules first), r/ClaudeAI and the relevant Discords (MCP, x402/CDP, LangChain, CrewAI, n8n), posted in their designated showcase channels.
- Content: a technical post on the design (node floor, payload-free logging, gateway-only metering), a transparent economics post (what nodes earn, why payouts are off pending legal review), and a monthly public network report.
- Respond to abuse reports publicly with metadata-only facts (ABUSE_CONTROLS.md #9).

## 7. Phased timeline

### Phase 0 — pre-launch (Nov 9 – Nov 22, 2026)
- [ ] Production deploy: API, gateway, Postgres with backups (`scripts/backup.sh` / `restore.sh`), Caddy/nginx TLS (DEPLOYMENT.md §6), tunnel ingress (§5).
- [ ] Coordinator signing key (`npm run gen:coord-key`) held offline, pins embedded in node-agent builds (DEPLOYMENT.md §1–2), rotation runbook rehearsed (§3).
- [ ] ASN DB installed with a cron (`scripts/update-asn-db.sh`, DEPLOYMENT.md §4).
- [ ] Publish `@dominusnode/mcp-server`, SDKs v2 and integrations (release workflow), then the MCP Registry listing.
- [ ] Legal: counsel status on ECONOMICS.md §4 open items (payouts, money transmission, tax, ToS/AUP/contributor attestation text). **Launch with `PAYOUTS_ENABLED=false`** and say so everywhere.
- [ ] Fix the stale discovery document in `packages/dashboard/src/server.ts` (see §9).
- [ ] Run the smoke gate (≥3 nodes for 2 h plus a Base Sepolia earn → mature → withdraw cycle) and `scripts/smoke/relay-smoke.sh`.
- [ ] Abuse inbox (abuse@), a published AUP and a response SLA of 24 h.

### Phase 1 — seeded private beta (Nov 23 – Dec 20, 2026)
- [ ] Deploy about 40 seed nodes (§4.1) and pass the soak gate (≥20 nodes for 72 h).
- [ ] Invite 20–40 agent developers: launch partners, plus applicants from a waitlist form. Starter credits are on for invitees only.
- [ ] Invite 10–25 outside node operators (Genesis cohort start) in under-covered countries.
- [ ] Weekly feedback call; fix the top 5 issues each week.

### Phase 2 — public launch (target week of Jan 11, 2027; avoid the holiday weeks)
- Proceed only if all §8 gates are green for 14 consecutive days.
- Show HN, Product Hunt and community posts the same week; all directory listings live; status page public; starter credits public with caps; Bazaar indexing verified.

### Phase 3 — growth (Feb – Jun 2027)
- Open node signup by country waitlist, driven by unmet-demand data.
- Turn on payouts once counsel signs off. This is the biggest supply lever.
- Remote MCP endpoint with OAuth, for the Claude/ChatGPT directories.
- Monthly network report; retire seed DC nodes as community capacity grows; partner integrations with browser-infra companies.

## 8. Metrics, launch gates and kill criteria

| Metric | Beta gate (end Phase 1) | Public-launch gate (14 d green) | Phase 3 target (Jun 2027) |
|---|---|---|---|
| Healthy nodes online | ≥30 | ≥40 (≥10 community) | ≥500 (≥80% community) |
| Countries / distinct ASNs | ≥10 / ≥8 | ≥12 / ≥12 | ≥30 / ≥100 |
| Request success rate (excluding target-side 4xx) | ≥97% | ≥98.5% | ≥99% |
| Latency overhead over direct, p50 / p95 | ≤300 / ≤1200 ms | ≤250 / ≤1000 ms | ≤200 / ≤800 ms |
| Paid GB/day (other-principal) | ≥1 | ≥10 | ≥500 |
| Node earnings/day (community) | — | ≥$1 | ≥$75 |
| Abuse reports / 1k paid GB | ≤2, all resolved in 24 h | ≤1 | ≤0.5 |
| Starter-credit abuse (grants clawed back or flagged) | ≤10% | ≤5% | ≤3% |

**Kill / rollback criteria** (any one triggers them):
- A credible legal or ISP complaint that our controls can't trace to a requester: pause new requester signups.
- Any SSRF or LAN-reach finding against a node: stop the gateway routing to community nodes (seed-only) until it is fixed.
- A payment rail or facilitator warning: pause that rail.
- Success rate under 95% for 24 h: freeze marketing and new invites.
- Starter-credit abuse above 15%: turn grants off.
- Beyond 8 weeks, if paid GB/day is under 5 after public launch, cut seed spend to the 20-node minimum and refocus on the 2–3 niches with traction, rather than buying growth.

## 9. Risks and mitigations

| Risk | Already built | Still needed |
|---|---|---|
| Abuse through contributor IPs (spam, credential stuffing, fraud) | Port policy, category denylist, SSRF floor in the node, per-node and per-requester caps, burn reputation, metadata-only abuse log, consent attestation (ABUSE_CONTROLS.md #1–9); burn-report weighting; daily collusion job (`/api/admin/network/collusion/flags`) | Public abuse-report form, abuse SLA runbook, KYT/sanctions screening of x402 payer wallets |
| IP reputation burn (targets blocking the pool) | Per-(node,target) burn detection and cool-downs | Monitoring of public blocklists (Spamhaus, IPQS) for seed IPs, and communications for contributors |
| Sanctions | OFAC country blocks at registration and the gateway; payout wallet screening (DESIGN.md §15) | Screening of payer wallets on x402/MPP |
| Legal/regulatory (payouts = money transmission?, tax, proxy liability, carrier ToS) | `PAYOUTS_ENABLED` off; W-9/W-8 thresholds designed | Counsel opinion; ToS/AUP/attestation text reviewed; DMCA/abuse agent designation; GDPR DPA for the metadata log |
| Sybil farming of tiers or grants | Other-principal, matured traffic only; distinct-/32 and ≥3-payer IP rule; per-/32, /24 and ASN caps; beneficial-owner aggregation; tier-scaled node caps | Grant-specific caps (§5.2), referral linkage checks |
| Chicken-and-egg stall | Seed-node design (DESIGN.md §11), cheap prices, x402 no-signup | Starter credits, status page, waitlist by country, launch partners |
| Security incident in the gateway or SDKs | Security rules, audits, CI security workflow | External pentest before Phase 2; bug bounty in Phase 3 |
| Reputational: "another residential proxy botnet" | Opt-in node agent with attestation | Public sourcing statement; never bundle (§4.3) |

## 10. Owner task list: next 2 weeks (Nov 9 – Nov 22)

| Day | Task |
|---|---|
| Mon 9 | Book counsel review of ECONOMICS.md §4 items and the attestation, ToS and AUP text. Open abuse@ and security@ mailboxes. |
| Mon 9 | Provision production hosts (gateway with unmetered bandwidth), DNS and TLS; deploy API and gateway; restore-test backups. |
| Tue 10 | Generate the coordinator key offline, embed pins and build node-agent releases (DEPLOYMENT.md §1–2). Install the ASN DB and its cron. |
| Wed 11 | Fix the discovery doc (§11 gap 1). Add `mcpName` and a registry `server.json`. Publish the MCP server, SDKs and integrations. |
| Thu 12 | Publish to the MCP Registry, Smithery, Glama, mcp.so and awesome-mcp-servers (descriptions say "alpha, payouts not live"). |
| Fri 13 | Bring up 3 nodes in staging and pass the smoke gate, including the Base Sepolia earn → withdraw cycle. |
| Mon 16 | Order seed VPSs (30 across ≥8 ASNs and 10 countries); set up 2–4 residential lines with signed attestations. |
| Tue 17 | Write (or have built) the seed-node deploy script (§11 gap 4) and deploy all seeds. Start the 72 h soak. |
| Wed 18 | Settle a test x402 payment through the CDP facilitator; run the Bazaar validate endpoint; confirm the listing. |
| Thu 19 | Write 3 end-to-end examples and the quickstart README; set up the waitlist form and a community Discord with rules. |
| Fri 20 | Contact 10 launch-partner candidates personally (no mass email). Draft (don't post) the Show HN and blog posts. |
| Sat 21 – Sun 22 | Review soak results against §8. Go/no-go for Phase 1 invites on Nov 23. |

## 11. Code / product gaps (checked against the repo on 2026-11-06)

| # | Gap | Exists? | Notes |
|---|---|---|---|
| 1 | Accurate agent discovery document | **Exists but stale** | `packages/dashboard/src/server.ts` (~L270–330) still advertises `email_password` signup, `dc-/residential-` pool prefixes (`routing_format: "{pool_type}-country-{ISO2}"`), and hardcoded $5/$3 per GB and "free_dc 500 MB" tiers. That contradicts the v2 rules (prices from `network_pricing`, hyphen flags, no email/password) and would mislead agents and directories. Fix before any listing. |
| 2 | Starter credits for new agents (capped, expiring, non-withdrawable, excluded from tiers) | **No** | Nothing grants on signup. Needs a grant ledger, per-/24 and per-funding-source caps, a global daily budget and admin toggles. |
| 3 | Referral codes | **Partial (legacy), off** | `referral_codes` / `referral_redemptions` tables and `/api/referrals` routes. Redemption at signup is off unless an admin sets `referral_settings.redemption_enabled` (`PUT /api/admin/network/referrals/settings`), and even then it only records the referral: it pays no balance bonus. Free credit for new principals comes only from the starter-credit grant ledger (§5.2). A referrer reward still needs the sybil checks above (beneficial-owner linkage, payout only after the referee's matured paid traffic) before it is built. |
| 4 | Seed-node deploy script (cloud-init/Ansible, systemd unit, pinned build, attestation) | **No** | Only `packages/node-agent/scripts/gen-coord-pins.mjs` and `infra/docker/{api,frontend,proxy}.Dockerfile` exist; there is no node-agent Dockerfile or systemd unit. |
| 5 | Public network status page | **Partial** | `GET /v1/network/stats`, `/v1/pricing` and `/v1/policy` exist (`routes/v1/public.ts`); there is no public page, latency or success-rate history, or incident log. |
| 6 | Genesis boost (time-limited extra bps plus a demand-gated grant) | **No** | Needs a `genesis_until` column per beneficial owner, snapshotted with `tier_id`/`node_share_bps`, capped at 5000. |
| 7 | MCP Registry metadata (`mcpName`, `server.json`) | **No** | Only the custom `packages/mcp-server/mcp-server.json`. Also add `smithery.yaml` and a Dockerfile (Docker MCP catalog). |
| 8 | x402 Bazaar discovery metadata on gateway resources | **Yes (verify listing)** | 402s carry v1 `outputSchema` (discoverable) plus v2 `resource` and `extensions.bazaar`; see PAYMENTS.md "x402 Bazaar discovery". Still to do: settle through CDP and run the validate endpoint. |
| 9 | Unmet-demand logging (country/class requested with no eligible node) feeding a "wanted" list and a waitlist | **No** | Drives the coverage bonus and node invites. |
| 10 | Seed vs community labeling in stats | **No** | Needed for honest reporting. |
| 11 | Remote MCP (HTTP plus OAuth) | **No** | Needed for the Claude/ChatGPT connector directories (Phase 3). |
| 12 | Payer-wallet sanctions/KYT screening on x402/MPP | **Verify / likely no** | Payout wallets are screened; payer wallets are not documented. |
| 13 | Public abuse-report intake form | **No** | Backed by the existing metadata-only abuse log lookup. |

**Update 2026-11-12:** starter-credit funding precondition (Base nonce ≥1 or a ≥$1 paid top-up, fails closed; ECONOMICS.md §7), the genesis entry rule (≥3 distinct unlinked paying principals; ECONOMICS.md §9), x402 Bazaar metadata (PAYMENTS.md), and an agent-facing announcements feed (`GET /v1/announcements`, AGENT_API.md) are in place with admin controls on the Launch page.
