# Security Policy

DominusNode is a relay network for AI agents. We welcome good-faith security research and will work with you to fix what you find. This policy is the `Policy` referenced by the gateway's `/.well-known/security.txt`.

## Reporting a vulnerability

- Email **security@example.org** (operators of a deployment replace this with the contact configured for their coordinator; the live address is always the `Contact` line of `/.well-known/security.txt`).
- Or open a private [GitHub security advisory](https://github.com/0xcircuitbreaker/DomiNode/security/advisories/new) on this repository.
- Do not open public issues for vulnerabilities.

Include affected component and version or commit, reproduction steps, impact, and any proof-of-concept. Never include real API keys (`dn_live_`, `dn_node_`), wallet private keys or other people's data in a report; redact them.

## Scope

In scope:

- The relay gateway (`packages/proxy-gateway`): HTTP/HTTPS/SOCKS5 front end, node tunnel, byte metering, node selection.
- The exit node agent (`packages/node-agent`), including its SSRF/private-range floor.
- The REST API (`packages/dashboard`): `/v1` agent routes, `/api` routes, admin routes, discovery and webhook endpoints.
- Billing and payment rails (`packages/billing`): x402, MPP, Tempo, NOWPayments, wallet crediting, credit maturity and payouts.
- The MCP server, the six v2 SDKs (`sdks/`) and the AI integrations (`integrations/`).
- The admin frontend and browser extension.

Out of scope:

- Abuse of the relay by its users (report that via `/report-abuse` instead).
- Third-party services (payment processors, chains, CDNs, hosting providers).
- Denial of service by volume, spam, social engineering, physical attacks.
- Findings that need a compromised device, a root shell or a malicious browser extension.
- Missing best-practice headers or banner disclosures without a demonstrated impact.

Examples of what we especially want to hear about: SSRF or DNS-rebinding bypasses of the node floor, billing or metering bypasses, double crediting, authentication or signature-verification bypasses, cross-agent data access, credential leakage in errors or logs, and ways for an exit node to influence billed bytes.

## Safe harbor

If you act in good faith under this policy we will not pursue or support legal action against you, and we consider your research authorized. Good faith means you:

- Test only against your own accounts, wallets and nodes, or a gateway you run yourself.
- Do not access, modify or keep other agents' data beyond the minimum needed to show the issue, and delete it afterwards.
- Do not degrade the service for others, route abusive traffic through other people's exit nodes, or move funds you do not own.
- Give us reasonable time to fix the issue before disclosing it publicly.

If a third party brings action against you for activity that followed this policy, we will make it known that your actions were authorized.

## Response targets

| Stage | Target |
|---|---|
| Acknowledgement | within 3 business days |
| Initial triage and severity | within 7 days |
| Fix or mitigation, critical | within 14 days |
| Fix or mitigation, high | within 30 days |
| Fix or mitigation, medium/low | within 90 days |
| Coordinated public disclosure | after the fix ships, or at 90 days by agreement |

We will keep you updated during triage and credit you in the release notes unless you ask us not to. The project is in alpha and has no paid bug bounty yet.

## Supported versions

Only the latest `master` and the currently deployed gateway are supported. SDKs: the latest v2 release of each.
