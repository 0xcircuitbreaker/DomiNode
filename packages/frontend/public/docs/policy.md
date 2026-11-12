# DominusNode network policy and abuse controls

The active policy is public: `GET https://api.dominusnode.com/v1/policy` returns `{version, sha256, body, floorGuarantees}` with an `ETag` of the hash, so agents can see exactly which rules are in force.

## Controls

| Control | Where | Can the operator turn it off? |
|---|---|---|
| Contributor consent attestation (wallet-signed) | Node registration | No; text changes force re-attestation |
| Destination port policy (80/443 plus configurable list) | Gateway | List is configurable |
| Destination category denylist (bank/gov logins, checkouts, account creation) | Gateway | List is configurable |
| SSRF and private-range blocking | Gateway **and** node agent | **No** |
| OFAC sanctions (Cuba, Iran, North Korea, Russia, Syria) | Registration and gateway geo | List configurable, master switch not |
| Per-node rate, concurrency and GB/day caps | Gateway scheduler | Defaults; operators may only lower their own |
| Per-requester rate limits and spend caps | Gateway | Defaults and per-agent overrides |
| Reputation and burn detection | Coordinator | Thresholds |
| Metadata-only abuse log (time, requester, node, host, bytes; never payloads or full URLs) | Coordinator | Retention window only |

## Guarantees

- No third-party IP upstream: every exit is a node run by an agent that consented.
- No payload logging, anywhere.
- The node floor runs inside the contributor's own software and can only be made stricter.
- HTTPS is end-to-end; plaintext HTTP requires `allowhttp-1` because the exit can read it.

## Reporting abuse

Anyone can report abuse seen from a DominusNode exit, without an account, at the [report form](https://dominusnode.com/report-abuse) or directly against the API:

1. `POST https://api.dominusnode.com/v1/abuse-reports/challenge` returns `{challengeId, prefix, difficulty, algorithm: "sha256", expiresAt}`. Find a `nonce` (at most 32 chars) so that `sha256(prefix + nonce)` has `difficulty` leading zero bits.
2. `POST https://api.dominusnode.com/v1/abuse-reports` with `{"pow": {"challengeId", "nonce"}, "destHost", "windowStart", "windowEnd", "category", "description", "contact"?}`. `destHost` is a bare hostname, the window is ISO times (at most 31 days, within the last year), `category` is one of `spam`, `credential_stuffing`, `scraping`, `fraud`, `ddos`, `illegal_content`, `other`, and the description is 10-4000 characters.

The response is `201 {id, status: "new", receivedAt, responseTarget: "24h"}`. Limits: 20 challenges and 5 reports per IP per hour. The reporter's IP is not stored. The metadata log lets the operator trace the requesting agent and suspend it.
