# Federation

Status of the federation work from BOOTSTRAP_PLAN.md §1.3. Delivered: F1, F2, F6, F8. Still on the roadmap: F3, F4, F5, F7.

The aim is that anyone can run a coordinator, and nodes and clients can find and check it by domain name. They do not need hostnames or keys built into the code, and there is no token. One coordinator can answer on several domains. For example, the official network can be served on `dominusnode.com` and on a `daedalusdevelopmentgroup.com` subdomain at the same time. Hostnames are configuration only.

## Signed documents

Every document uses the same envelope:

```json
{ "payload": { ... }, "signatures": [{ "alg": "ed25519", "public_key": "<hex64>", "sig": "<hex128>" }] }
```

Each signature covers the UTF-8 bytes of `"<domain>\n" + canonicalJson(payload)`. Canonical JSON sorts keys and has no whitespace (`canonicalJson` in `packages/shared/src/policy.ts`). The domain separates document types:

| Document | Path | Signature domain |
|---|---|---|
| Coordinator identity (F1) | `/.well-known/dominusnode/coordinator.json` | `dominode-coordinator-v1` |
| Network policy (F6) | `/.well-known/dominusnode/policy.json` | `dominode-policy-v1` |

Because the domains differ, a policy signature can never verify as an identity document, and neither can verify as a tunnel CHALLENGE (`dominode-challenge-v1`). Both documents are signed with the coordinator key the gateway already uses, `COORD_SIGNING_KEY_FILE`. If no key is set, the API returns 503 for these paths.

A key fingerprint is `sha256:` followed by the hex SHA-256 of the raw 32-byte ed25519 public key.

Verification is in `packages/shared/src/federation.ts`: `verifyCoordinatorDocument` and `verifyPolicyDocument`. A document passes only when all of the following hold:
- The signature verifies, and its key is listed in the payload. When pins are given, the key must also be pinned.
- Each listed fingerprint matches its key.
- `issued_at` is no more than 7 days old (configurable) and no more than 5 minutes in the future.
- For policy, `sha256` equals the hash of the policy body.

## F1: coordinator identity document

The payload contains these fields:
- `coordinator_keys`: each key with its fingerprint
- `hostnames`: a list of hostnames
- `site_name`
- `api_url`
- `gateway`: `http_proxy`, `socks5_proxy` and `tunnel_url`
- `policy`: `version`, `sha256` and `url`
- `pricing_url`
- `operator`: `name`, `contact` and `abuse_contact`
- `software_version`
- `issued_at`

The API rebuilds the document from config and the active policy, and caches it for 5 minutes.

| Env | Meaning |
|---|---|
| `APP_URL` | Public API base URL (required) |
| `COORDINATOR_HOSTNAMES` | Comma list of every domain this coordinator answers on. Falls back to `DOMINUSNODE_DOMAIN`, then to the `APP_URL` host |
| `PROXY_PUBLIC_HOST`, `PROXY_HTTP_PORT`, `SOCKS5_LISTEN_PORT` | Gateway endpoints |
| `COORD_TUNNEL_URL` | `wss://…/v1/tunnel`. Defaults to `wss://relay.<first hostname>/v1/tunnel` |
| `COORD_ADDITIONAL_PUBKEYS` | Extra public keys to list during a key rotation |

## F2: node agent joining a coordinator by domain

```bash
DN_NODE_COORDINATOR=coord.example.org dominusnode-node run
# prints: signing key fingerprint: sha256:…  and refuses
DN_NODE_COORDINATOR=coord.example.org DN_NODE_TRUST=sha256:… dominusnode-node run
```

The agent works through these steps:
1. It fetches the document over HTTPS, with redirects refused, a 10 s timeout and a 300 KB cap.
2. It verifies the signature and freshness, and requires the domain to appear in `hostnames`.
3. It prints the fingerprint.
4. It refuses to continue unless `--trust` / `DN_NODE_TRUST` names exactly that fingerprint. This is trust on first use with an explicit confirmation step. Check the fingerprint out of band.

After that, the agent uses the document's `api_url`, `tunnel_url` and keys as coordinator pins. Explicit `DN_NODE_API_URL` and `DN_NODE_GATEWAY_URL` still take precedence. Without `DN_NODE_COORDINATOR`, nothing changes: the embedded official pins and URLs are the default. Code: `packages/node-agent/src/coordinator.ts`.

## F6: policy as a signed, versioned file

`GET /.well-known/dominusnode/policy.json` serves the active policy with its version and hash. `/v1/policy` keeps working as before. To export a file for the repo or a mirror, run:

```bash
npm run build
COORD_SIGNING_KEY_FILE=coord.pem npm run export:policy -- --out policy.json             # active policy from DB
COORD_SIGNING_KEY_FILE=coord.pem npm run export:policy -- --policy body.json --version 3 # from a file
```

Other coordinators can adopt the same floor by importing the body. Users can diff two policy files.

## F8: branding for forks

`SITE_NAME`, `OPERATOR_NAME`, `OPERATOR_CONTACT` and `ABUSE_CONTACT` are config. The official DDG site name, operator name and default contact (`mailto:0xcircuitbreaker@protonmail.com`) appear only when the coordinator's public key is listed in `OFFICIAL_COORD_PUBKEYS`. On any other key, the defaults are neutral, and a configured name that claims the DDG operator is replaced. `/.well-known/security.txt` uses the same contact and returns 404 when none is configured.

## Roadmap

- **F3**: a node serves several coordinators at once, with one tunnel per coordinator and caps for each coordinator taken from the node's own floor.
- **F4**: IDs namespaced by coordinator (node, principal and session IDs) in APIs and SDK types.
- **F5**: signed, append-only hourly metering summaries for each node. Nodes compare them with their local byte counters.
- **F7**: a protocol spec covering tunnel frames, handshake, AUTH binding and these document formats, kept separate from DESIGN §2.
- Later work: a gossip or directory list of coordinator domains, so discovery does not depend on one well-known operator.
