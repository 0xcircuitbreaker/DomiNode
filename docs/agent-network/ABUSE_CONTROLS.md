# Abuse Controls in the Agent Relay Network

Every byte relayed through the network leaves through an IP that another agent's
operator contributed. If that traffic is abusive, the complaint, the ban or the
legal letter goes to **the contributor's** connection — not to the requesting agent
and not (at first) to DomiNode. Abuse controls are what make it rational for anyone
to contribute an IP. They are a supply-side feature, not a tax on users.

## The controls

| # | Control | Enforced where | What it does to the system | Admin-panel controllable |
|---|---------|----------------|----------------------------|--------------------------|
| 1 | **Contributor consent attestation** | Node registration (coordinator) | A node cannot join the pool without a signed attestation (wallet signature) that the operator owns/controls the connection and accepts relaying. Gives contributors a clear legal posture and gives us something to point to. | Attestation text + version (forces re-attest on change); revoke a node |
| 2 | **Destination port policy** | Gateway, before a node is chosen | Only 80/443 (+ configurable list). Blocks SMTP (25/465/587) spam, SSH/RDP brute-force, IRC botnets. Single most effective control. | Allowed ports list |
| 3 | **Destination category denylist** | Gateway | Refuses known high-abuse categories (bank/gov login endpoints, payment checkouts, account-creation endpoints of major platforms). Kept as a versioned list. | Add/remove domains & patterns; per-category toggles |
| 4 | **SSRF / private-range blocking** | Gateway **and** node agent | Stops requesters from reaching a contributor's LAN (router admin, NAS, cloud metadata 169.254.169.254) via the exit. Enforced twice because the node is the one at risk. | **No** — must not be turnable off |
| 5 | **OFAC sanctions** | Registration + gateway geo | No nodes from, and no routing to/through, sanctioned jurisdictions. | List is configurable, but the master switch should not be |
| 6 | **Per-node rate & concurrency caps** | Gateway scheduler | Limits req/s, concurrent streams and GB/day through any one IP, so a single requester can't burn a contributor's IP reputation. Also spreads earnings. | Default caps; node operators can set lower caps themselves |
| 7 | **Per-requester rate limits & spend caps** | Gateway | Bounds damage from a compromised or malicious requesting agent. | Defaults, per-agent overrides, suspend |
| 8 | **Reputation & burn detection** | Coordinator | Tracks block/captcha rates per (node, target). Requesters that burn many IPs pay more or get throttled; burned nodes cool down. | Thresholds, manual flags |
| 9 | **Metadata-only abuse log** | Coordinator | Stores (time, requester id, node id, dest host, bytes) — **never** payloads or full URLs — for a fixed retention window, so an abuse complaint against an IP can be traced to the requesting agent and that agent suspended. | Retention window; lookup by node+time |

## How they affect the system

- **Latency:** 2–5 are string/set checks before dialing: microseconds. 6–8 are
  in-memory counters. Only DNS resolution for SSRF (4) adds real time, and it is
  required anyway to pick a geo-appropriate node.
- **Supply:** controls 1, 2, 4 and 6 are what let a contributor say yes. Without
  them, expect contributors to churn the first time their ISP sends a notice.
- **Demand:** 2 and 3 exclude some use cases (email sending, account farming). Those
  are exactly the use cases that get residential networks shut down.
- **Revenue:** abuse that gets the platform delisted by payment rails / x402
  facilitators / hosting zeroes revenue. 7 and 9 are what let us respond to a
  complaint with "here is the agent, it is suspended" instead of losing the service.

## "Should they be removed because we are decentralized?"

No — but they should be split by where trust lives:

- **Node-side controls (4, and a contributor's own copy of 2, 3, 6) cannot be
  removed by anyone, including us.** They run inside the node agent the contributor
  installs. This is the decentralization story: a contributor doesn't have to trust
  DomiNode to protect their LAN or their IP; their own software enforces a floor.
  Contributors can only make them *stricter*.
- **Coordinator-side controls (1, 3, 5, 7, 8, 9) are operator policy**, adjustable
  from the admin panel and published at a public `/v1/policy` endpoint with a
  version hash, so agents can see exactly what rules are in force.
- **Things that would be a mistake to make toggleable:** SSRF/private-range blocking
  and the payload-free logging guarantee. Weakening either is the one change that
  turns "decentralized relay" into "liability for every contributor".

## Burn-report weighting and collusion (implementation notes)

- **Burn reports** (`POST /v1/sessions/:id/report`) feed `nodes.report_penalty`
  through the hourly `report-reputation` job. Each report is weighted by the
  reporter's paid 30-day spend on the reported node only
  (`min(1, spend / REPORT_FULL_WEIGHT_SPEND_CENTS)`, default $10; 0 below
  `REPORT_MIN_NODE_SPEND_CENTS`, default $0.50; disputed charges and spend to an
  owner who also paid the reporter's nodes (circular flow) do not count). At most
  `REPORT_MAX_LOW_WEIGHT_REPORTERS` (5) partial-weight reporters count per node.
  Reports decay with a half-life (`REPORT_HALF_LIFE_DAYS`, 7), is capped per
  reporter per node (`REPORT_MAX_PER_REPORTER`, 3 reports) and per node
  (`REPORT_MAX_PENALTY`, 2000 points; `REPORT_POINTS_PER_REPORT`, 100). Reports
  against your own or a teammate's nodes are ignored, so a reporter with no
  real spend on that node has ~0 weight. Selection and tiers use
  `reputation - report_penalty`; quarantine uses the base reputation only. When
  the report penalty alone would drop a node below the quarantine threshold the
  gateway opens an admin review flag (`collusion_flags` kind `report_penalty`)
  instead of quarantining it.
- **Verified exit class** (ECONOMICS.md §1a, DEPLOYMENT.md §4a): a node's
  class comes only from the gateway's classification of its observed egress IP
  (connect-time peer IP, re-checked by the canary echo probe), never from the
  node. During a connection the class only moves to the more conservative
  value (`masked` > `unknown` > `dc` > `residential`/`mobile` in caution), and
  the registry is updated immediately, so a node re-classified `masked` stops
  serving `class-residential`/`dc`/`mobile` and unflagged requests at once.
  When the verified class is below the owner's declared class (e.g. declared
  residential, exits via a VPN) the gateway opens an admin review flag
  (`collusion_flags` kind `egress_mismatch`, one open flag per node, refreshed
  on re-detection) in the same review queue as collusion and report-penalty
  flags. The flag never changes money by itself; the class downgrade already
  reprices new sessions. Privacy: the classification reuses `nodes.observed_ip`
  (already stored, already erased with the node owner); only the class, the
  declared class and a timestamp are added, and logs carry node ids and
  classes, not IPs.
- **Class verification on (re)connect.** With `PROBE_URL` set, a node that
  connects is `unknown` (never matches `class-*`, lowest tier weight snapshot,
  any-price quote) until a probe on that connection verifies it; every connect
  is queued for its own probe (`PROBE_CONNECT_CONCURRENCY`, per-node
  `PROBE_CONNECT_MIN_INTERVAL_MS`), on top of the sampled periodic job. The
  last probe verdict is stored (`nodes.probe_class`, `probe_class_at`) and the
  connect-time class is the more cautious of the peer-IP class and that
  verdict, so redialling from a residential IP does not undo a probe
  downgrade. An `egress_mismatch` flag is raised when the probe class is below
  the declared class or below the connect-time class (also for nodes that
  declared nothing). Prepaid (x402/MPP) and balance-funded sessions both
  snapshot the class tier weight at session start.
- **Limit: split routing is not reliably detectable.** Probes go to echo
  endpoints the gateway controls. A modified node agent (the code is open and
  nodes are untrusted) can send probe destinations out through one path (its
  home ISP) and customer traffic through another (WARP, a VPN, a VPS). To make
  this harder, `PROBE_URL` takes a comma-separated list of echo URLs and one is
  picked at random per probe: operators should list several hostnames that are
  not published as gateway endpoints (CDN fronts, random subdomains on a
  separate domain). That raises the cost of steering probes; it does not prove
  the path of customer traffic. The exit class is therefore **best effort**:
  it reliably catches honest operators behind WARP/VPN and naive split
  tunnels, not a node agent written to defeat it. Passive checks on real
  traffic (sampling customer CONNECTs to known IP-reflection endpoints,
  destination-observed IPs on plain relays) are a planned follow-up. Burn
  reports and buyer `sessions.report` remain the backstop.
- **Collusion** (DESIGN.md §13 commit 33): the daily `collusion` job flags
  requester/owner concentration and circular buying, admin-visible at
  `/api/admin/network/collusion/flags` (ADMIN_API.md §12). Automatic credit
  freeze above a high threshold is available but off by default.

The security pitch to agents is therefore: *no third-party upstream, no payload
logging, a policy you can read, and a node floor nobody can switch off.*

## Launch additions (implementation notes)

- **Public abuse-report intake** (`POST /v1/abuse-reports`, AGENT_API.md): no account and no captcha, gated by a single-use SHA-256 proof-of-work from the existing `pow_challenges` table, 5 reports and 20 challenges per IP per hour, 16 KB body cap. It stores the destination host, the time window, a category and a description (plus an optional contact) and never the reporter's IP. Admins triage at `/api/admin/network/abuse-reports`, which shows how many metadata-only `relay_abuse_log` rows match the host and window; the requester lookup itself goes through the audited abuse-log endpoint (control #9). The target is a response within 24 h.
- **Payer sanctions screening** (control #5 extended to payers): x402/MPP payer wallets are checked against the local OFAC SDN address list (`PAYER_SDN_FILE`, default `PAYOUT_SDN_FILE`) after verification and before settlement. A listed wallet gets `403 PAYER_SANCTIONED` and is never charged. In production a missing list refuses paid requests (fail closed); outside production that is opt-in with `PAYER_SDN_REQUIRED=true`.
- **Starter-credit abuse caps:** see ECONOMICS.md §7 (global daily budget, per-/24 and per-funding-source caps, expiry, no tier credit, seed-nodes-only routing during the first month so free traffic never exits through community IPs).
- **Unmet demand** is logged as (hour, country, class) counts only, so it cannot be used to trace requesters.
