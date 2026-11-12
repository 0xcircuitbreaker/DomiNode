# DominusNode bootstrap plan (solo, zero budget) — drafted 2026-11-12

Status: draft for the owner, not committed. It **replaces the resourcing assumptions** in LAUNCH_PLAN.md (about 40 paid seed nodes, a funded beta, launch partners with $100 credits, Product Hunt) for as long as the project is run by one unfunded developer. LAUNCH_PLAN.md stays the reference for directory steps (§2), lessons from other networks (§1), and what not to do (§4.3). This plan reuses those and leaves out anything that costs money.

Starting position: one developer, personal hardware, one X account, a public MIT repo (github.com/0xcircuitbreaker/DomiNode), packages at 2.0.0 on npm/PyPI/crates.io/Go plus the MCP server, and daedalusdevelopmentgroup.com (DDG) with some AI-crawler traffic and an agent service that DominusNode will sit under as a subdomain (DEPLOYMENT.md §0, §9).

Web facts were checked on 2026-11-12. Many sources are secondary (marked as such), so re-check a number before quoting it publicly. Nothing here is legal advice.

---

## 1. Decentralization: what is true today, and a path a solo dev can execute

### 1.1 Honest architecture today

| Component | Who runs it | Decentralized? |
|---|---|---|
| Exit nodes (`packages/node-agent`) | Anyone who opts in | **Yes.** Untrusted, and the SSRF/port floor is enforced on the node itself (ABUSE_CONTROLS #4) |
| Gateway (`packages/proxy-gateway`): HTTP/SOCKS5 front end, node selection, tunnel server, **the only byte meter** | The owner | **No.** Single operator, single point of failure and trust |
| Coordinator (registry, tiers, probes, policy, signing key `gen:coord-key`) | The owner | **No.** Nodes pin its ed25519 key (DESIGN §2.4, T11) |
| API, ledger, Postgres (`packages/dashboard`, `shared`) | The owner | **No.** Balances, credits and earnings sit in one database |
| Payments (x402/MPP/Tempo/NOWPayments) | Facilitators, keyed to the owner's wallets | Rails are open protocols, but the receiving account is the owner's |
| Code, SDKs, integrations | MIT, public | **Yes.** Anyone can fork and run it |

Say this publicly, in the README and on the site, in these words: *"Open-source and self-hostable. The public network at dominusnode.daedalusdevelopmentgroup.com is currently run by one operator. Exit nodes are independent; the gateway, metering and ledger are not (yet)."* Over-claiming decentralization is the fastest way to lose the crypto/agent crowd's trust, and it carries consumer-protection risk.

The bar to aim for is **"credibly exit-able"**, meaning (1) anyone can run the whole stack with one command, (2) a node can point at any coordinator, (3) the policy and the code are public and versioned, and (4) the money side is auditable. Running everything trustlessly is not the goal.

### 1.2 Stage A: run the coordinator on your own hardware

**A hard constraint from the code decides which hosting options work at all.** The gateway exposes **raw TCP** (8080 HTTP proxy, 1080 SOCKS5, 8443 TLS proxy). The node tunnel must see **the node's real peer IP**, because sybil caps and geo checks key on it (DEPLOYMENT §5: `X-Forwarded-For` is never trusted, and only PROXY protocol v2 from `TUNNEL_TRUSTED_PROXY_IPS` is accepted). That leads to the following:

- **Cloudflare Tunnel (free) works for the HTTP parts only:** the site, `api.` (`/v1`, `/api`, `/status`, `/.well-known`). It **cannot** carry public raw-TCP proxy ports to arbitrary clients, because Cloudflare's arbitrary-TCP mode needs `cloudflared` on the client and the public product (Spectrum) is paid. It **must not** carry the node tunnel either: the peer would be Cloudflare's edge, which breaks the per-IP sybil/geo controls, and Cloudflare terminating TLS breaks the channel binding and SPKI pins. Cloudflare's CDN terms have also historically restricted serving disproportionate non-HTML content on self-serve plans. Their scope changed in 2023 and the secondary sources disagree on the details ([selfhostedworld](https://selfhostedworld.com/guides/cloudflare-tunnel), [r/selfhosted thread](https://axebps-redlib.hf.space/r/selfhosted/comments/13j4pft/goodbye_section_28_and_hello_to_cloudflares_new), [localtonet](https://localtonet.com/blog/cloudflare-tunnel-alternative), all secondary). Never route relayed bytes through Cloudflare. Read the current Service-Specific Terms before relying on it even for the API.
- **The gateway therefore needs a public IPv4 with TCP ports reachable**, either the home IP itself or a small L4 relay (VPS) in front of it that forwards TCP and adds PROXY v2. The PROXY v2 path is already implemented (DEPLOYMENT §5, Option A).

Options:

| Option | Cost | Pros | Cons / ToS / legal |
|---|---|---|---|
| **A1. Home server (mini PC / old laptop) + home IP + DDNS + port forwards** | $0 (power ~$2–5/mo) | Simplest; all data stays on your box | Many ISPs use **CGNAT** (no inbound possible), and DDNS changes break pinned hostnames. **Residential ISP terms commonly forbid running servers or reselling/sharing the connection, so read yours.** Every byte crosses your home uplink about twice (in from the node, out to the client). The home IP becomes publicly tied to a proxy service. Fine for a private alpha, poor beyond that |
| **A2. Home server for Postgres/API/coordinator + Cloudflare Tunnel (free) for HTTP only + home IP for gateway TCP ports** | $0 | Hides the home IP for the website/API and gives free TLS/DDoS shielding for HTTP | Gateway TCP ports still expose the home IP, so this saves less than it looks |
| **A3. Home server (DB, API, coordinator jobs, signing key) + small VPS running the gateway** (recommended) | $4–6/mo (Hetzner/OVH-class VPS with unmetered or ~20 TB traffic) | Clean public IP, stable DNS, no ISP server-ToS problem at home, and the relay bandwidth leaves from a datacenter. The DB and the money stay on hardware you own. The VPS can also be one of the first DC exit nodes | Recurring cost (small). The gateway needs a DB connection to home: use WireGuard/Tailscale (free tier) from VPS to home, never expose Postgres. **Check the VPS provider's AUP on proxy services.** Many allow proxies you operate but forbid open proxies and act on abuse reports. You are running an authenticated proxy, so keep the abuse inbox answered |
| **A4. Oracle Cloud Always Free as the gateway** | $0 | Free public IPs. A third-party blog claims 10 TB/mo outbound; that is not confirmed in Oracle's docs, so verify | Oracle **halved the Always Free Arm allowance to 2 OCPU / 12 GB from 2026-06-15** ([InfoQ](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/), [Oracle docs](https://docs.cloud.oracle.com/Content/FreeTier/freetier.htm)). Oracle reclaims idle instances and has been known to terminate free accounts without much recourse, so treat it as disposable. Its AUP on proxy services must be read. Capacity is often unavailable in popular regions. Good as a **second/backup gateway or L4 relay**, not as the only one |
| **A5. Fly.io / Railway** | — | — | **No longer free for new accounts.** Fly.io offers a 2-VM-hour / 7-day trial ([agentdeals](https://agentdeals.dev/vendor/fly-io), [flaviocopes, Sept 2026](https://flaviocopes.com/hosting-free-tiers.md), secondary). Railway gives a one-time $5 trial, then $1/mo credit ([Railway docs](https://docs.railway.com/pricing/free-trial.md)). Egress is metered, which is bad for a relay. Skip |

**Recommendation.** A2 for the website and API from day one. A1 is acceptable for the gateway only during a private alpha with fewer than 10 people. Move to A3 the moment anything is public. A4 is a free standby gateway. The coordinator signing key lives offline or on the home box, never on the VPS (DEPLOYMENT §1).

Budget reality: **$0 is possible for a private alpha. About $5/month is the honest minimum for a public launch.** Do not pretend otherwise.

### 1.3 Stage B: one-command self-host, federation-ready from day one

The goal is that `curl … | sh` or `docker compose up` brings up Postgres, API, gateway, frontend and a local node on any Linux box, with its own coordinator key.

What already exists: `docker-compose.yml` (Postgres only), `docker-compose.vps.yml` (frontend, api, caddy), `docker-compose.prod.yml`, `infra/docker/{api,proxy,frontend}.Dockerfile`, `packages/node-agent/Dockerfile`, `infra/caddy`, `scripts/gen-coord-key.mjs`, `scripts/seed/deploy-node.sh`, `scripts/smoke/relay-smoke.sh`, `scripts/backup.sh`/`restore.sh`.

What is missing is in §7 (tasks E1–E3).

The **federation-readiness changes** below are the minimal changes that let independent coordinators coexist later without a token:

| # | Change | Why | Effort |
|---|---|---|---|
| F1 | **Coordinator identity document** at `/.well-known/dominusnode/coordinator.json`: coordinator pubkey(s), gateway/relay hosts, policy hash, pricing URL, operator contact, abuse contact, software version, all signed by the coordinator key | Lets nodes and clients discover and verify a coordinator by domain instead of by baked-in constants | 1 day |
| F2 | **Node agent: first-class multi-coordinator config.** Today `DEFAULT_API_URL`/`DEFAULT_GATEWAY_URL` point at the DDG hosts, and coord pins are embedded at build time, with `DN_NODE_COORD_PINS` able only to *add* pins (`packages/node-agent/src/config.ts`). Add `DN_NODE_COORDINATOR=<domain>`, which fetches F1, shows the pubkey fingerprint and requires an explicit `--trust <fingerprint>` (TOFU with a confirmation step). Keep the embedded pins as the default for the official network. A per-coordinator key file is already one path (`DN_NODE_KEY_FILE`) | Any operator can run a coordinator and attract nodes without forking or rebuilding the agent | 2–3 days |
| F3 | **Node serves several coordinators at once** (one tunnel per coordinator, with per-coordinator caps from the node's own floor) | Nodes are not locked to one operator, which is the most meaningful decentralization lever | 3–5 days |
| F4 | **Namespace IDs by coordinator.** Node IDs, principal IDs and session IDs carry or are scoped by the coordinator ID in APIs and SDK types; SDKs accept a `coordinator` base URL (already overridable via `DOMINUSNODE_API_URL` / `baseUrl`) | Avoids collisions and confusion once there are many coordinators | 1–2 days (docs plus types) |
| F5 | **Signed, append-only public metering summaries**: hourly per-node byte totals and earnings, signed by the coordinator and published (in the network snapshot, which exists: `NETWORK_SNAPSHOT_INTERVAL_MS`). Nodes compare them with their own byte counters and flag gaps over X% | Turns "trust the meter" into "verify the meter". Nodes already count bytes locally | 2–3 days |
| F6 | **Policy as a versioned, signed file in the repo** (`/v1/policy` already has a version hash; publish the signed file and changelog) | Lets other coordinators adopt the same floor and lets users diff policies | 0.5 day |
| F7 | **Protocol spec document** (tunnel frames, handshake, AUTH binding, F1 format) separated from the implementation in DESIGN §2 | A second implementation or coordinator can be written without reading the TS code | 1–2 days |
| F8 | **Self-hosters keep the branding off.** `DOMINUSNODE_DOMAIN`, site name and contact are config; the official DDG name is not shown on forks by default | Avoids people mistaking a fork for the official network (and impersonation complaints) | 0.5 day |

### 1.4 Stage C: longer-term federation without a token

No ICO, no airdrop, no points, no "early contributors may receive…" language. Options, in rough order of realism:

1. **Many independent coordinators plus multi-homed nodes** (F1–F5). Like email or the fediverse: each coordinator sets its own prices and policy above the shared floor, and nodes pick which ones to serve. Requesters choose a coordinator like they choose an RPC provider. This is achievable by one person.
2. **A public coordinator directory**: a plain JSON list in a GitHub repo, added to by PR, carrying each coordinator's F1 document and uptime from the public status page. There is no on-chain registry. The DDG coordinator is just one entry.
3. **Cross-coordinator settlement over x402**: coordinator A can buy capacity from coordinator B's gateway per request with x402, exactly like any agent. This needs no new protocol, since x402 is already the rail.
4. **On-chain settlement and escrow for node earnings** (later, after counsel): node earnings accrue as signed receipts that a node can redeem from a coordinator's escrow contract in USDC. This removes the "trust the operator's ledger" problem without a token. It is complicated and has legal implications (money transmission), so it is a 2027+ question.
5. **Governance**: a `GOVERNANCE.md`, a CODEOWNERS file listing outside maintainers once they exist, and RFCs as GitHub discussions for floor/policy changes. Optionally, apply later to a fiscal host such as Open Collective or a Linux Foundation project space.

---

## 2. Supply bootstrap at zero budget

### 2.1 The owner's own hardware as nodes 1–5

| Node | Class | Notes |
|---|---|---|
| Home line (mini PC / Raspberry Pi / old laptop) | residential | The most valuable node, since residential is what buyers want. Risks below |
| The A3 gateway VPS (also runs a node agent) | dc | Free, because you already pay for it. Be clear in stats that it is operator-run |
| Oracle Always Free VM (A4) | dc | Second DC country/ASN; verify the AUP |
| A phone hotspot or a spare SIM router | mobile | **Most carrier ToS forbid tethering for servers or reselling. Skip unless your plan explicitly allows it** |
| A friend's/family member's line | residential | Only with their informed, signed attestation (control #1), and only if they understand what an exit IP is |

Flag every one of these `operator_run` (DEPLOYMENT §7) so `/v1/network/stats` reports "N operator-run / M community". Their earnings go back to the platform principal and do not count for tiers.

**Home residential IP risks and mitigations:**

- **The ISP terms risk** is real. Read the AUP for "servers", "resale", "proxy" or "sharing". If it forbids them, do not run a public exit on that line. Some business-class residential plans allow it, and that is worth the upgrade only once there is revenue.
- **IP reputation**: the home IP may land on proxy/abuse lists (Spamhaus, IPQS, Cloudflare bot scores), leading to CAPTCHAs for the whole household. Mitigate with low per-node caps (ABUSE_CONTROLS #6: set GB/day and concurrency low, e.g. 2 GB/day and 4 streams), the port floor (80/443 only), and the destination denylist (#3).
- **Network isolation**: put the node on a **separate VLAN or guest network** with client isolation, or on a dedicated cheap router/AP. Firewall it from the LAN (no access to the NAS, printers or router admin). The node's own SSRF floor (#4) cannot be switched off, but defence in depth is cheap. Run the node in the hardened systemd unit (`infra/systemd/dominusnode-node.service`) or the uid-1001 Docker image.
- **Legal exposure**: someone else's request leaves from your IP. The metadata-only abuse log (#9) is what lets you show "requester X did this, now suspended". Keep it on, with a documented retention.
- **Do not** run the gateway and the residential node on the same home IP in public mode. It ties your identity to every exit byte and doubles uplink use (option A3 fixes this).
- **Kill switch**: a single `systemctl stop` or router rule, and you are allowed to use it. Write down how to use it.

### 2.2 Friends and early adopters: "bring your own node"

The best early supply comes from **agent developers who already run servers** (homelab, VPS, Raspberry Pi). The pitch: "your idle box, 10 minutes of setup, and you get free relay bandwidth for your own agents."

- Ask in your own network first: DMs to people you know, plus one honest post asking for 5 testers.
- Give each a short written explainer of what an exit node does, what they agree to, and the kill switch, before they install.
- Cap invite-only supply at about 10–15 nodes until there is demand to route to them (LAUNCH_PLAN §1, Mysterium lesson: supply outrunning demand causes churn).

### 2.3 Incentives without cash

`PAYOUTS_ENABLED=false` stays off until counsel says otherwise (DESIGN §15, ECONOMICS §4). Within that:

- **Credits-for-bandwidth**: node earnings accrue as credits (already the case) and convert into requester balance via `credits.convert`, so the node's owner gets free bandwidth on the network. State clearly that **credits are not cash, not withdrawable now, and may never be**, with no "future value" language.
- **Reciprocity tier**: anyone running a healthy node gets a discount or free quota (e.g. 1 GB/month free bandwidth per node that kept ≥95% uptime with paid traffic from others). This is a config/credits-grant job, not a token.
- Reuse the existing **genesis and starter-credit machinery** (`GENESIS_JOB_INTERVAL_MS`, starter credits) with small numbers. A $0.50 starter credit costs real money only when it sends paid bytes to *community* nodes. Cap the global daily budget at something you can afford, e.g. $1/day.
- **Recognition**: a "first nodes" list in the README (opt-in, by handle only) and a monthly thank-you in the network report. This costs nothing and works.

### 2.4 What NOT to do

- **No node-ware bundled in SDKs, integrations, the extension, or any app.** That is the IPIDEA/911 S5 model that Google and the FBI took down (LAUNCH_PLAN §1, §4.3). It would get the packages pulled from npm/PyPI, the extension from the Chrome store, and the domain flagged, and it creates computer-misuse liability.
- **No paying for installs**, no incentivized-install networks, no "earn passive income" ads.
- **No buying other providers' residential proxies to resell as nodes.**
- **No astroturfing**: no sock-puppet accounts, no fake "community nodes", no inflating node counts, no reply bots, no star buying.
- **No uptime-for-points** and no airdrop or token hints.
- **No nodes on employer, university, cloud-provider-forbidden or public networks.**

---

## 3. Zero-budget demand

### 3.1 Niches where a small network is still useful

1. **"A handful of real residential IPs in country X"**: geo-checks of one's own sites (localized pricing, cookie banners, geo-fenced flows, CDN behaviour), SERP checks by country, and QA. Low volume, high value per request, and tolerant of a small pool. Publish exactly which countries are available on the status page.
2. **x402 pay-per-request with no signup**: an agent with a USDC wallet pays per request and fetches, with no key, no account and no KYC. Few competitors offer this for egress. It is a good demo and the reason to list on x402 Bazaar.
3. **MCP users** (Claude Desktop/Code, Cursor, etc.) who want "fetch this page from a German IP" as a tool: `npx @dominusnode/mcp-server`.
4. **Agent developers who also run servers**, the two-way market: they run a node, earn credits, and spend them. The supply side and the demand side are the same person.
5. **Privacy-minded or self-hosting developers**: "run your own coordinator for your own team's egress". Even if they never use the public network, they become contributors, stars and word of mouth.

Be honest about the limits: there is no unblocker, no CAPTCHA solving, the pool is tiny and the service is alpha. **Not for high-volume scraping.** Saying so filters out abusive users too.

### 3.2 Free distribution channels, with steps

Many of these are already detailed in LAUNCH_PLAN §2. Do one listing at a time, honestly, and mark the project as alpha everywhere.

| Channel | Steps | Time |
|---|---|---|
| **Official MCP Registry** | Already wired (`packages/mcp-server/server.json`, `/.well-known/mcp/server.json`). Confirm the listing resolves; on each release run `mcp-publisher publish` | 0.5 h |
| **PulseMCP** | Auto-indexes from the registry; use the submit form if it is missing after a week | 0.25 h |
| **Smithery** | Sign in with GitHub → add a server → point it at the repo / add `smithery.yaml` with stdio config and the `DOMINUSNODE_API_KEY` config schema | 1–2 h |
| **Glama** | GitHub sign-in → submit the repo. Its score weighs LICENSE, SECURITY.md, CI and tool descriptions, so make sure these exist (secondary source in LAUNCH_PLAN §2) | 1 h |
| **mcp.so** | Submit button / GitHub issue on its repo | 0.5 h |
| **awesome-mcp-servers (punkpeye)** | One-line PR in the correct category, following its CONTRIBUTING (alphabetical, emoji legend), with no superlatives | 0.5 h |
| **Docker MCP Catalog** | PR to `docker/mcp-registry` (needs a Dockerfile for the MCP server) | 3 h, later |
| **x402 Bazaar / Agentic.Market** | Index after the first settled payment through the CDP facilitator with discovery metadata; check with the validate endpoint (LAUNCH_PLAN §2 rows 8–9) | 0.5 day |
| **LangChain docs** | PR to the integrations/tools page linking `integrations/langchain`, with a minimal notebook | 0.5 day |
| **LlamaHub** | Publish `llama-index-tools-dominusnode` to PyPI and open the PR | 0.5 day |
| **CrewAI** | Community tools listing / docs PR with an example crew | 0.5 day |
| **n8n community nodes** | Publish `n8n-nodes-dominusnode` with the `n8n-community-node-package` keyword. It appears in search once on npm; verification is optional | 0.5 day |
| **Composio, Dify marketplace, Flowise, Langflow, Mastra, Vercel AI SDK** | Each has a plugin/toolkit submission. `integrations/` already contains them, so do one per week, not all at once | 2 h each |
| **GitHub** | Topics: `mcp`, `mcp-server`, `ai-agents`, `proxy`, `residential-proxy`, `x402`, `socks5`, `self-hosted`, `decentralized`. Badges: npm/PyPI/crates versions, CI, license, MCP Registry. Pin the repo on the profile. Enable Discussions. Add "good first issue" labels on §7 tasks | 1 h |
| **Show HN** | One post: "Show HN: DominusNode – open-source, self-hostable relay network for AI agents (x402, MCP)". It must be something people can try right away (the local demo mode, task E3), with no vote solicitation, and you answer every comment yourself. Post Tue–Thu morning US Eastern | 2 h plus a day of replies |
| **Lobsters** | Needs an invite. Ask someone you know there, or skip it. Do not ask strangers | — |
| **Reddit** | r/selfhosted (the self-host angle; read the rules, which typically require self-hosted software and disclosure), r/mcp, r/LocalLLaMA (strict self-promo limits), r/webscraping (check self-promo rules; often weekly threads only), r/homelab (for nodes, angled as "I built…"). **Read each sub's rules the day you post**, disclose that you built it, and space posts at least a week apart | 1 h each |
| **dev.to / Hashnode** | Cross-post 3 technical articles (canonical URL on the DDG blog): (1) how the node SSRF floor and gateway-only metering work, (2) x402 pay-per-request egress from an agent in 20 lines, (3) running a coordinator on a mini PC for $5/mo | 3–4 h each |
| **DDG site** | See §3.4 | — |

### 3.3 X (Twitter): a 4-week plan for one founder account

Rules: you write every post yourself, no scheduled reply bots, no engagement pods, no paid boosts, and you disclose when you mention your own project in a reply. About 30–45 minutes a day.

| Week | Posts (≈4–5/week) | Replies (daily, ~15 min) |
|---|---|---|
| 1: "why" | Thread: why an agent-only relay network, and why open-source and self-hostable (honest "it is centralized today, here's the path"). A 30-second screen recording: `npx @dominusnode/mcp-server` → Claude fetches a page from a residential IP. A post on the node SSRF floor with a code screenshot | Find conversations on MCP tools, x402, browser agents, "agents getting blocked". Answer the technical question first; mention DominusNode only if it actually solves their problem |
| 2: "build in public" | A day-by-day thread on the home-server coordinator setup (with photos of the mini PC, its cost and its power draw). A GIF of the status page. A post asking for 5 node testers, with full honesty about the risks | Reply to x402/Coinbase/Base dev posts with working examples (not links alone) |
| 3: "proof" | A demo video: an agent paying with x402, no signup, fetching from a German exit. "Week 3 numbers" (nodes, agents, GB), even if tiny. A thread on the design decision that only the gateway counts bytes | Answer questions from the HN/Reddit launch, if done this week |
| 4: "invite" | A self-host guide thread (one command, your own coordinator). "Looking for contributors" with linked good-first-issues. A monthly network report (first edition) | Thank contributors by handle (with consent) |

Formats that work for solo developers: 20–40 second terminal recordings (asciinema → GIF, or OBS), honest numbers, and one clear call to action per post.

### 3.4 Using DDG and its agent service

- **Subdomain**: `dominusnode.daedalusdevelopmentgroup.com` (DEPLOYMENT §0, §9). The site already ships `llms.txt`, `llms-full.txt`, `robots.txt` with named AI crawlers allowed, `sitemap.xml` and `/.well-known/mcp/server.json` (DISCOVERY.md).
- **Cross-link from DDG's root `llms.txt`**: add a `## Products` section entry linking the DominusNode `llms.txt` and `docs/*.md`. AI crawlers already visit DDG, so this is the cheapest discovery win.
- **DDG agent service**: if it can call tools, give it DominusNode as a built-in egress tool (dogfooding), and say so in its docs. If it publishes an agent card or tool listing, add DominusNode.
- **DDG blog post**: "Why we built an open-source relay network for agents" (canonical, cross-posted to dev.to). Link it from the DDG homepage/products nav, the footer, and the agent-service page.
- **Structured data**: the JSON-LD `SoftwareApplication` plus `Organization` exists. Add the GitHub repo as `sameAs`/`codeRepository`.

---

## 4. Grants and free programs

Verify each one before applying; details changed often during 2026.

| Program | Fit | Status (as found 2026-11-12) | Link |
|---|---|---|---|
| **Base Builder Grants** | Good, if x402 settles on Base and Builder Codes are added | Reported "Season 2" with $5,000 grants (Oct 2026, secondary); the docs still describe retroactive 1–5 ETH grants for shipped projects. Apply-anytime form; requires a live onchain product | [docs.base.org get-funded](https://docs.base.org/get-started/get-funded.md), [Paragraph post](https://paragraph.xyz/@grants.base.eth/calling-based-builders), [coinalertnews (secondary)](https://coinalertnews.com/news/2026/10/27/base-grant-programs-ecosystem) |
| **Base Batches / Creator grants** | Creator grants (up to $4,000) cover tutorials/docs, so the x402 tutorial series fits | Check the current cohort | [crypto.news](https://crypto.news/base-launches-creator-grant-program-with-up-to-4000-for-creators/) |
| **x402 Foundation (Linux Foundation)** | Strong topical fit | Operational since 2026-07-14; stated priorities include developer tooling **grants**, but no public application process found. Watch x402.org and contribute to the spec/ecosystem list | [LF press](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications) |
| **Coinbase CDP / x402 hackathons** | Bounties and prizes are often in USDC | Event-based; watch the CDP Discord/X | — |
| **Gitcoin Grants** | Open-source + Ethereum ecosystem | GG24 OSS round ran Oct 2025 (on Giveth); GG25 planned for 2026 with a narrower domain focus (d/acc), and dates are unconfirmed | [gov.gitcoin.co strategy](https://gov.gitcoin.co/t/gitcoin-2026-strategy-tl-dr/25049), [grants.gitcoin.co](https://grants.gitcoin.co) |
| **Optimism Retro Funding** | Weak unless deployed on OP chains or providing dev tooling for them | Rounds change yearly; check the current season | retrofunding.optimism.io |
| **NLnet / NGI Zero** | Good fit for open internet infrastructure, **but** a proxy network will draw scrutiny | NGI Zero Commons Fund's **final call closed 2026-06-01**; NLnet paused calls and said it would resume with a 2026-11-03 deadline (passed). Watch for the next call | [nlnet.nl/commonsfund](https://www.nlnet.nl/commonsfund), [NLnet news](https://nlnet.nl/news/2026/20260612-NGIZero-stocktaking.html) |
| **GitHub Sponsors** | Yes | Free; 0% fee for personal sponsorships | github.com/sponsors |
| **Open Collective** | Yes, for transparent budgets (hosting, a domain) | Free to create; fiscal hosts (e.g. Open Source Collective) charge a fee | opencollective.com |
| **Cloud credits** | Useful for the gateway | AWS Activate, Google for Startups, Azure for Startups, DigitalOcean Hatch: most now want an incorporated startup, sometimes VC-referred; **check that they allow proxy services**. Credits expire, so don't build a dependency on them | provider sites |
| **Free OSS tooling** | Yes | GitHub Actions (free for public repos), Codecov/Sonar free OSS tiers, Socket/Snyk OSS | — |

Pattern: apply only where the project already fits. Lead with "open-source, self-hostable, ethically sourced exits, x402-native", and attach real usage numbers, even small ones.

---

## 5. Legal and safety minimums for a solo exit-network operator

Practical checklist, not legal advice; get a lawyer before turning payouts on.

1. **Abuse contact**: `abuse@` on the DDG domain, monitored daily, and listed in WHOIS/RDAP where possible, in the site footer, in the F1 coordinator doc and in `security.txt`. A public abuse-report form already exists (PoW-protected, `ABUSE_REPORT_POW_DIFFICULTY`). Target a first response within 24 h, and say it is best effort while solo.
2. **ToS + AUP + contributor attestation**: short, plain language. Prohibited uses (fraud, account creation, credential stuffing, spam, CSAM, harassment, sanctions evasion, anything illegal at source or destination). Node operators attest that they control the connection and accept relaying (control #1). Version them, since re-attestation is already supported.
3. **Payouts off**: `PAYOUTS_ENABLED=false`. Credits are not money and are not redeemable for cash. No exceptions for friends.
4. **Sanctions**: keep the OFAC country block (Cuba, Iran, North Korea, Russia, Syria), install the SDN address list on the gateway (`PAYER_SDN_FILE`, `PAYER_SDN_REQUIRED=true` in production; otherwise x402/MPP returns 503 by design), and refresh it on a cron.
5. **Logging policy**: metadata only (time, requester, node, destination host, bytes), never payloads or full URLs. Use a fixed retention window (e.g. 30–90 days), published on the site and in `/v1/policy`. Have a short written procedure for responding to law-enforcement requests (what you hold, what you can't produce) before you need it.
6. **ISP and hosting terms**: read and save your ISP's AUP, the VPS's AUP and Oracle's AUP. If any forbids proxies, don't run that piece there.
7. **Payment rails**: x402/USDC is the main rail. NOWPayments has its own KYC/AUP terms. Avoid holding customer balances beyond small amounts. A ceiling already exists in the DB (`balance` CHECK ≤ $10,000), so lower it by admin config for the alpha if possible.
8. **Kill switches**: suspend a requester, revoke a node, stop the gateway. Rehearse them (admin suspend already revokes keys and signals the gateway).
9. **Entity**: running under DDG (if it is a company) separates personal liability somewhat. Ask an accountant how relay revenue is taxed where you live.
10. **Security hygiene**: the coordinator key offline (DEPLOYMENT §1), backups (`scripts/backup.sh`) to an encrypted off-box location, 2FA everywhere (GitHub, npm with trusted publishing already set up, PyPI, registrar, Cloudflare), and the release workflow's provenance.

---

## 6. Eight-week plan (one person)

Assumes about 10–15 h/week alongside other work. Start: Mon 2026-11-16.

| Week | Focus | Deliverables | Hours |
|---|---|---|---|
| 1 (Nov 16) | Self-host and local demo | E1 one-command self-host, E3 local demo mode, home server running API/DB behind a Cloudflare Tunnel (HTTP only). README honesty section (§1.1) | 15 |
| 2 (Nov 23) | Gateway public and first nodes | Gateway on a $5 VPS (A3) via WireGuard to home, TLS proxy (8443) on. Nodes: VPS (dc), home on a VLAN (residential), Oracle (dc). Run the smoke gate (≥3 nodes for 2 h, `scripts/smoke/relay-smoke.sh`). ToS/AUP/abuse inbox live | 15 |
| 3 (Nov 30) | Node in 60 seconds and status | E4 node one-liner, E5 public status page linked everywhere. Invite 3–5 friends/known devs as node testers. X week 1 | 12 |
| 4 (Dec 7) | Directories | MCP Registry check, Smithery, Glama, mcp.so, PulseMCP, awesome-mcp-servers PR, GitHub topics/badges. DDG `llms.txt` cross-link and DDG blog post. X week 2 | 10 |
| **Checkpoint 1 (end of week 4)** | **Go/no-go for a public post:** ≥3 nodes up ≥95% for 7 days, 0 unresolved abuse reports, smoke test green, at least 1 outside person ran the self-host or node install successfully. **No-go:** fix reliability first; slip the public post by 2 weeks | | |
| 5 (Dec 14) | Show HN + r/selfhosted | E6 demo agent, x402 first real payment (Bazaar indexing check). Show HN (Tue–Thu) and one subreddit. X week 3 | 15 (+ reply time) |
| 6 (Dec 21) | Holiday week, keep it light | Fix the top issues from launch feedback; answer issues. Grant application: Base Builder (if x402 is live on Base) | 6 |
| 7 (Dec 28) | Framework listings | LangChain, n8n, LlamaHub (one or two only). dev.to article 1. X week 4 | 10 |
| 8 (Jan 4) | Federation groundwork and review | F1 coordinator doc and F6 signed policy; first monthly network report; GitHub Sponsors/Open Collective pages | 12 |
| **Checkpoint 2 (end of week 8)** | See metrics below | | |

**Success metrics (realistic targets for week 8):**

| Metric | Target | Stretch |
|---|---|---|
| Nodes online (7-day avg) | 5 (≥2 not run by the owner) | 10, in ≥3 countries |
| Distinct agents/principals with ≥1 successful request | 10 | 30 |
| First paid GB (x402 or top-up, from someone other than the owner) | ≥1 GB | 10 GB |
| Self-host installs reported (issue/discussion/X) | 2 | 5 |
| GitHub stars | 50 | 200 |
| Abuse reports resolved in <48 h | 100% | — |
| Gateway uptime | 99% | 99.5% |
| Monthly cash cost | ≤ $10 | — |

**Go/no-go at week 8:**

- **Go, keep pushing the hosted network**: ≥1 paid GB from outsiders, ≥5 nodes, and no unmanageable abuse.
- **Pivot to "software first"**: if paid demand is ≈0 but self-host interest exists, focus on the self-host/federation story (F1–F7) and treat the DDG network as a reference instance. This matches "truly open source and decentralized" anyway.
- **Pause the public network**: if abuse reports exceed what one person can handle (e.g. >3/week with real ISP notices), or an ISP/VPS warns you. Keep the code, stop the public exit, and fix the controls first.

---

## 7. Engineering tasks that most help this plan

Checked against the repo on 2026-11-12. "Exists" means the repo already has it.

| # | Task | What exists | What to build | Effort |
|---|---|---|---|---|
| E1 | **One-command self-host** (`scripts/selfhost/install.sh` + `docker-compose.selfhost.yml`) | Separate compose files (`docker-compose.yml` Postgres only; `vps.yml` frontend/api/caddy; `prod.yml`), Dockerfiles for api/proxy/frontend/node, `gen-coord-key.mjs`, `db:migrate` | A single compose with postgres + migrate job + api + proxy + caddy + optional local node; an install script that generates the coord key, `.env` (random secrets, domain prompt), pins and the TLS mode; idempotent re-run for upgrades | 2–3 days |
| E2 | **"Home server + VPS gateway" guide** (`docs/agent-network/SELF_HOST.md`) with Cloudflare Tunnel for HTTP only, WireGuard/Tailscale to the DB, Caddy layer4/PROXY v2 for the tunnel, CGNAT notes | DEPLOYMENT §5 Option A/B covers PROXY v2 and TLS | A guide with copy-paste config and the reasons Cloudflare must not carry proxy/tunnel traffic | 1 day |
| E3 | **Local demo mode**: `docker compose -f docker-compose.demo.yml up` → API + gateway + one local node + a pre-funded demo principal; `curl -x http://relay:<demo key>@localhost:8080 https://example.com` works in 2 minutes | Gateway refuses non-public tunnel peers in production only; `NODE_ENV=development` path exists (`docker-compose.local.yml`) | A demo profile: dev coord key, loopback-node allowance in dev only, a seed script for a demo principal plus credits, a clear "DEMO, NOT FOR PRODUCTION" banner | 1.5–2 days |
| E4 | **"Run a node in 60 seconds"** one-liner: a published multi-arch image (`ghcr.io/0xcircuitbreaker/dominusnode-node`) with official pins baked in, plus `docker run … register` interactive first-run (shows what is shared, asks for the attestation signature, writes the key file 0600 uid 1001) | `packages/node-agent/Dockerfile` (needs `DN_COORD_PUBKEYS` build arg), `scripts/seed/deploy-node.sh`, systemd unit | GHCR publish workflow (arm64 for Raspberry Pi), a first-run register subcommand inside the container, docs with recommended low caps for home lines | 1.5–2 days |
| E5 | **Public status from day one** | `/status` page served by the API (`status-page.ts`), `/v1/network/stats`, hourly network snapshots | Link it everywhere; add an operator-run vs community split and countries available; optionally a static mirror (GitHub Pages cron) so status survives a home outage | 0.5–1 day |
| E6 | **Tiny demo agent** (`examples/geo-check-agent/`): ~50 lines, Node SDK, fetches a URL from 2 countries and diffs the result; an x402 variant that pays per request with a testnet/low-balance wallet | SDKs v2, MCP server, integrations | The example plus a 30-second recording for README/X/HN | 0.5–1 day |
| E7 | **Federation readiness F1, F2, F6** (coordinator doc, `DN_NODE_COORDINATOR` with TOFU confirmation, signed policy file) | Embedded pins + additive `DN_NODE_COORD_PINS`; policy version hash | See §1.3 | 3–4 days |
| E8 | **Verifiable metering F5** (signed per-node hourly byte summaries; node-side compare and alert) | Network snapshots job; node byte counters | Signing, publishing, and a node-side check | 2–3 days |
| E9 | **Multi-coordinator node F3** | — | One tunnel per coordinator, per-coordinator caps | 3–5 days |
| E10 | **Reciprocity grant** (free monthly quota for healthy community nodes, credits only) | Genesis/starter-credit jobs and credits ledger | One job and an admin setting; excluded from tier tenure | 1 day |
| E11 | **Branding/config for forks F8 and a `GOVERNANCE.md`/`SECURITY.md`/CONTRIBUTING with good-first-issues** | Check SECURITY.md exists (Glama score) | Docs and a config switch | 0.5–1 day |
| E12 | **Cost guardrails for a solo operator**: global daily cap on starter/reciprocity grants, per-node GB/day defaults for residential, bandwidth alarm on the VPS | Abuse caps (#6, #7) are admin-editable | Defaults tuned for a 5-node network, plus one alert (email/Telegram webhook) on abuse report or bandwidth spike | 0.5–1 day |

Order: E3 → E1 → E4 → E5 → E6 (before any public post), then E2, E12, E11, then E7 → E8 → E10 → E9.
Total before Show HN: about 7–9 working days.

---

## Sources (checked 2026-11-12)

- Oracle Always Free cut to 2 OCPU/12 GB from 2026-06-15: https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ ; Oracle docs: https://docs.cloud.oracle.com/Content/FreeTier/freetier.htm
- Cloudflare self-serve/CDN content terms discussion (secondary): https://selfhostedworld.com/guides/cloudflare-tunnel , https://localtonet.com/blog/cloudflare-tunnel-alternative , https://axebps-redlib.hf.space/r/selfhosted/comments/13j4pft/goodbye_section_28_and_hello_to_cloudflares_new
- Fly.io / Railway free tiers: https://agentdeals.dev/vendor/fly-io , https://flaviocopes.com/hosting-free-tiers.md , https://docs.railway.com/pricing/free-trial.md
- NLnet NGI Zero Commons Fund final call / pause: https://www.nlnet.nl/commonsfund , https://nlnet.nl/news/2026/20260612-NGIZero-stocktaking.html
- Base grants: https://docs.base.org/get-started/get-funded.md , https://paragraph.xyz/@grants.base.eth/calling-based-builders , https://coinalertnews.com/news/2026/10/27/base-grant-programs-ecosystem , https://crypto.news/base-launches-creator-grant-program-with-up-to-4000-for-creators/
- x402 Foundation: https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications
- Gitcoin 2026: https://gov.gitcoin.co/t/gitcoin-2026-strategy-tl-dr/25049 , https://grants.gitcoin.co
- Directory steps, proxyware takedowns, and the Bazaar: see the citations in LAUNCH_PLAN.md §1–§2.
