# Releasing

All SDKs, the MCP server and the AI integrations are published from this
repository by one workflow, `.github/workflows/release.yml`. No mirror repos
and no long-lived registry tokens are used.

## Private repository: what works, and "go public first"

The repository is currently **private**. Checked against the registry docs
(November 2026):

| Target | From a private repo | Source |
|---|---|---|
| npm Trusted Publishing (OIDC) | Works. Not listed as a limitation; only GitHub-hosted runners, npm >= 11.5.1 and Node >= 22.14 are required | https://docs.npmjs.com/trusted-publishers |
| npm provenance (`--provenance`) | **Fails**: "Provenance generation is not supported for private repositories, even when publishing public packages." The workflow adds `--provenance` only when `github.event.repository.private == false` | https://docs.npmjs.com/trusted-publishers |
| PyPI Trusted Publishing | Expected to work: the PyPI publisher docs put no visibility requirement on the repository (not verified by a publish yet) | https://docs.pypi.org/trusted-publishers/ |
| crates.io Trusted Publishing | Expected to work: crates.io documents no repository-visibility requirement (not verified by a publish yet) | https://crates.io/docs/trusted-publishing |
| Go module | Tags are created, but **proxy.golang.org cannot fetch a private repo**, so `go get github.com/0xcircuitbreaker/DomiNode/sdks/go/v2` only works with `GOPRIVATE` and git credentials. The proxy ping is skipped while private and the job prints a warning | https://proxy.golang.org |
| Maven (GitHub Packages) | Works; consumers need a `read:packages` token either way, and also read access to the repo while it is private | https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-apache-maven-registry |
| C++ release tarball | Uploaded, but only people with repo access can download it | |
| MCP Registry | `mcp-publisher login github-oidc` authenticates the `io.github.0xcircuitbreaker/*` namespace from the workflow's OIDC token | https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx |

**Go public first** (before announcing 2.0.0): npm, PyPI, crates.io and the
MCP Registry publish fine from the private repo, but the npm packages get no
provenance, `go get` fails for everyone without repo access, and the C++
tarball, Maven package and every README/CHANGELOG link point at a repo
nobody can open. Make the repo public, then re-run the workflow: published
versions are skipped and the Go proxy is pinged. npm provenance cannot be
added to a version after the fact; if provenance on 2.0.0 matters, go public
before the first release.

## How it works

1. `.github/release-packages.json` lists every publishable package: `id`, `path`,
   `ecosystem` (`npm`, `pypi`, `go`, `crates`, `maven`, `cpp-release`), where its
   version lives, its install/build/test commands and `dependsOn`.
2. On every push to `master`, `scripts/release/plan.mjs` reads each manifest
   version and checks whether that exact version is already out:

   | Ecosystem | "Already released" means |
   |---|---|
   | npm | `https://registry.npmjs.org/<name>/<version>` returns 200 |
   | PyPI | `https://pypi.org/pypi/<name>/<version>/json` returns 200 |
   | crates.io | `https://crates.io/api/v1/crates/<name>/<version>` returns 200 |
   | Go | git tag `sdks/go/v<version>` exists |
   | Maven (GitHub Packages), C++ | git tag `<id>-v<version>` exists |

   Anything missing (or published but not yet tagged) goes into the plan.
3. Per-ecosystem jobs install, build, test and publish each planned package.
   SDK jobs run first; the JS integrations wait for `@dominusnode/sdk` and the
   Python integrations for `dominusnode`, and each dependent job also polls the
   registry until the SDK version it needs is visible, so the integration is
   tested against the published SDK, not a local link.
4. Before publishing, every artifact goes through
   `scripts/release/check-artifacts.mjs` (see "Artifact check").
5. After a successful publish the job creates the tag (`<id>-v<version>`; Go:
   `sdks/go/v<version>`) and a GitHub Release whose notes are that version's
   section of the package's `CHANGELOG.md`.

Versions that are already published are skipped, so **merging a change without a
version bump releases nothing**.

### Where each package goes

| Ecosystem | Packages | Publishing |
|---|---|---|
| npm | 11 (SDK, MCP server, 9 JS integrations) | Trusted Publishing (OIDC), `npm publish --access public` (+ `--provenance` when the repo is public) |
| MCP Registry | `io.github.0xcircuitbreaker/dominusnode` (`packages/mcp-server/server.json`) | `mcp-publisher` v1.8.1 (sha256-pinned), `login github-oidc`, after the npm package is out |
| PyPI | 21 (SDK + 20 Python integrations) | Trusted Publishing via `pypa/gh-action-pypi-publish` |
| crates.io | `dominusnode` | Trusted Publishing via `rust-lang/crates-io-auth-action` |
| Go | `github.com/0xcircuitbreaker/DomiNode/sdks/go/v2` | Tag `sdks/go/vX.Y.Z`; proxy.golang.org is pinged when the repo is public |
| Maven | `io.dominusnode:dominusnode-sdk` | GitHub Packages of this repo, `mvn deploy` with `GITHUB_TOKEN` |
| C++ | `dominusnode-cpp` | GitHub Release with a source tarball of `sdks/cpp` and its `.sha256` |

Not published: `packages/node-agent` (`"private": true`; it ships as part of the
deployment), the platform packages, the frontend and the extension. The Dify
integration has a `pyproject.toml` and is published to PyPI as
`dominusnode-dify` (a Dify marketplace plugin bundle is not built here).
`gemini` and `openai-functions` ship both an npm and a PyPI package; their ids
are `gemini-js` / `gemini-py` and `openai-functions-js` / `openai-functions-py`.

Version sources: `package.json`, `pyproject.toml` (`[project] version`),
`Cargo.toml`, `pom.xml`, `SDKVersion` in `sdks/go/client.go`, and
`project(... VERSION ...)` in `sdks/cpp/CMakeLists.txt`.

## Cutting a stable release

1. Bump the version in the package's manifest (for Go, `SDKVersion` in
   `sdks/go/client.go`; a new major also needs the `/vN` module path suffix).
2. Add a `## X.Y.Z` (or `## [X.Y.Z] - date`) section to its `CHANGELOG.md`.
   **The planner fails** for a package to be released whose CHANGELOG.md is
   missing, has no section for the version, or has an empty one (HTML
   comments do not count). `node scripts/release/plan.mjs notes <id>` prints
   exactly what goes into the GitHub Release.
   For the MCP server, bump `version` and `packages[0].version` in
   `packages/mcp-server/server.json` together with `package.json` (a planner
   test and the MCP Registry job both check this).
3. If an integration needs the new SDK, raise its dependency range too.
4. Merge to `master`. The Release workflow publishes, tags and releases.

## Cutting a pre-release

Use a pre-release version:

- npm / Rust / Java / Go / C++: semver with a hyphen, e.g. `2.1.0-rc.1`. npm
  gets dist-tag `next` (never `latest`), so `npm i @dominusnode/sdk` keeps
  installing the last stable; `npm i @dominusnode/sdk@next` gets the RC.
- PyPI: PEP 440, e.g. `2.1.0rc1`. pip ignores it unless `--pre` or an exact
  pin is given.

The GitHub Release is marked as a pre-release. No release from this workflow is
marked "Latest", since the repo releases many packages.

Note that `^2.0.0` does not match `2.1.0-rc.1`; to test an integration against
an SDK RC, pin the RC explicitly in that integration.

## Dry run

Actions -> Release -> Run workflow, with `dry_run` ticked (the default) and
optionally a package id. Every planned package is installed, built and tested;
npm runs `npm publish --dry-run`, Rust `cargo publish --dry-run`, Python builds
and `twine check`s; nothing is uploaded, tagged or released.

Locally, `node scripts/release/plan.mjs` prints what would be released (it only
reads the registries and `git ls-remote`). `--only <id>` limits it, `--all`
lists up-to-date packages too. Planner tests: `node --test scripts/release/plan.test.mjs`.

## Artifact check

`scripts/release/check-artifacts.mjs` lists what each artifact actually
contains and fails the job, before anything is uploaded, on:

- tests and fixtures (`tests/`, `test_*.py`, `*.test.ts`, `conftest.py`, ...),
  `node_modules/`, source maps, `.env*`, `.npmrc`/`.pypirc`, key files;
- caches and debris (`__pycache__`, `*.pyc`, `*.log`, `*.tgz`, `.git/`,
  dev configs such as `tsconfig*.json`), `*.egg-info` outside the sdist root;
- secrets in file contents (`dn_live_`/`dn_node_`/... keys, PEM private keys,
  npm/PyPI/GitHub tokens, hex private-key assignments);
- any file over 1 MiB or an artifact over 5 MiB unpacked
  (`--max-file`, `--max-total`).

It runs on `npm pack --dry-run --json` output (npm), `dist/*` (PyPI sdist +
wheel), `target/package/*.crate`, the Maven jar and the C++ tarball. Local
use:

```bash
(cd integrations/vercel-ai && npm pack --dry-run --json --ignore-scripts > /tmp/pack.json)
node scripts/release/check-artifacts.mjs --list --root integrations/vercel-ai /tmp/pack.json
(cd integrations/langchain && python -m build --outdir /tmp/lc)
node scripts/release/check-artifacts.mjs --list /tmp/lc/*
```

What each artifact is allowed to contain is set in the package itself:
`files` in `package.json` (with `!dist/**/*.map`), `MANIFEST.in` for
setuptools packages, `[tool.hatch.build.targets.sdist]` for hatchling, and
`sdks/cpp/.gitattributes` (`export-ignore`) for the C++ tarball, whose
CMake test target is optional (`DOMINUSNODE_BUILD_TESTS`, on only when
`tests/` is present). Tests: `node --test scripts/release/check-artifacts.test.mjs`.

## MCP Registry

The `mcp-registry` job runs after the npm SDK-level jobs (which include
`@dominusnode/mcp-server`). It downloads `mcp-publisher` at a pinned version
and checks its SHA-256, checks that `server.json` `version` and the npm
package version equal `package.json` `version` and that `mcpName` equals
the server name, and runs `mcp-publisher validate`. It then publishes with
`mcp-publisher login github-oidc` + `mcp-publisher publish`, unless this is
a dry run, `GET /v0.1/servers/<name>/versions/<version>` already returns 200,
or that npm version is not on npmjs.com yet. No secret is needed; the job
has `id-token: write`. To upgrade the publisher, change
`MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` together.

## Deprecating 1.x on npm

Once every npm package is out at 2.0.0, run the workflow manually with
`deprecate_v1` ticked and `dry_run` unticked (with `dry_run` ticked it only
prints the commands). For each of the 11 npm packages whose 2.0.0 is on the
registry it runs

```
npm deprecate "<pkg>@<2.0.0" "Superseded by 2.x (DominusNode v2 relay network). Upgrade to 2.x; 1.x targets the retired API."
```

npm Trusted Publishing only authorizes publish and dist-tag operations, so
this job needs a granular npm token with read/write on the 11 packages, saved
as the secret `NPM_TOKEN` on the `release` environment. Delete the token
afterwards. Undo with `npm deprecate "<pkg>@<2.0.0" ""`.

## Re-running after a failure

Re-run the failed jobs (or the workflow). Each package is checked again: a
version that made it to the registry is not re-uploaded, an existing tag or
release is left alone, and only what is missing is done. A dependent whose SDK
failed is skipped; it is picked up once the SDK job succeeds on the re-run.
To release one package by hand, run the workflow with `package: <id>` and
`dry_run` unticked.

## One-time setup

All of this is done by the repo owner, once.

### a) PyPI: pending publishers (21 projects)

None of these projects exist on PyPI yet. The names are unclaimed until the
first upload; whoever uploads first owns the name, so set these up before the
first release.

1. Sign in at https://pypi.org (create the account / organization if needed,
   enable 2FA).
2. Open https://pypi.org/manage/account/publishing/ and add a **pending
   publisher** (GitHub) for each project below with:
   - PyPI project name: *(from the list)*
   - Owner: `0xcircuitbreaker`
   - Repository name: `DomiNode`
   - Workflow name: `release.yml`
   - Environment name: `release`

```
dominusnode
dominusnode-agent-zero
dominusnode-agno
dominusnode-autogpt
dominusnode-camel
dominusnode-composio
dominusnode-crewai
dominusnode-dify
dominusnode-gemini
dominusnode-haystack
dominusnode-ironclaw
dominusnode-langchain
dominusnode-langflow
dominusnode-llamaindex
dominusnode-metagpt
dominusnode-moltbook
dominusnode-openai-functions
dominusnode-pydanticai
dominusnode-semantic-kernel
dominusnode-superagi
dominusnode-taskweaver
```

The first OIDC upload turns each pending publisher into a normal trusted
publisher for that project.

### b) npm: trusted publishers (11 packages)

The packages already exist (at 1.5.2). For each one, open
`https://www.npmjs.com/package/<name>/access` -> **Trusted Publisher** ->
GitHub Actions, and enter organization/user `0xcircuitbreaker`, repository
`DomiNode`, workflow filename `release.yml`, environment `release`.

```
@dominusnode/sdk                https://www.npmjs.com/package/@dominusnode/sdk/access
@dominusnode/mcp-server         https://www.npmjs.com/package/@dominusnode/mcp-server/access
@dominusnode/chatgpt            https://www.npmjs.com/package/@dominusnode/chatgpt/access
@dominusnode/flowise-tools      https://www.npmjs.com/package/@dominusnode/flowise-tools/access
@dominusnode/gemini-functions   https://www.npmjs.com/package/@dominusnode/gemini-functions/access
@dominusnode/mastra-tools       https://www.npmjs.com/package/@dominusnode/mastra-tools/access
n8n-nodes-dominusnode           https://www.npmjs.com/package/n8n-nodes-dominusnode/access
@dominusnode/openai-functions   https://www.npmjs.com/package/@dominusnode/openai-functions/access
@dominusnode/openclaw-plugin    https://www.npmjs.com/package/@dominusnode/openclaw-plugin/access
@dominusnode/pi-extension       https://www.npmjs.com/package/@dominusnode/pi-extension/access
@dominusnode/ai-tools           https://www.npmjs.com/package/@dominusnode/ai-tools/access
```

npm requires `repository.url` in `package.json` to match the publishing repo
for Trusted Publishing and provenance; all 11 point at `https://github.com/0xcircuitbreaker/DomiNode`.

After the first successful OIDC publish of each package, on the same page under
**Publishing access** choose "Require two-factor authentication and disallow
tokens", and revoke any automation tokens at
https://www.npmjs.com/settings/0xcircuitbreaker/tokens.

### c) crates.io

The `dominusnode` crate already exists and is owned by `0xcircuitbreaker`
(earlier versions are yanked). At https://crates.io/crates/dominusnode/settings
add a **Trusted Publisher**: GitHub, owner `0xcircuitbreaker`, repository
`DomiNode`, workflow `release.yml`, environment `release`.

### d) GitHub

1. Create the environment `release` at
   https://github.com/0xcircuitbreaker/DomiNode/settings/environments
   and **before giving anyone else write access** configure it (required, not
   optional): under "Deployment branches and tags" choose "Selected branches
   and tags" and allow only `master`; add required reviewers (every publish
   job then waits for approval). Do the same for the `production` environment
   used by `deploy.yml`, and add a tag ruleset restricting who may create
   `v*`, `*-v*` and `sdks/go/v*` tags. Trusted publishers are bound to the
   environment, not a branch, so this rule is what stops a dispatched run on
   an unreviewed branch from publishing. `release.yml` and `deploy.yml` also
   refuse non-master refs themselves, but a branch can edit those checks, so
   they are defence in depth only.
2. At https://github.com/0xcircuitbreaker/DomiNode/settings/actions, under
   "Workflow permissions", allow GitHub Actions to create releases (the jobs
   request `contents: write` and, for Maven, `packages: write`; the default
   read-only setting is fine because the workflow asks for these explicitly,
   but an organization policy must not cap them). If a tag ruleset protects
   `*-v*` or `sdks/go/v*`, allow GitHub Actions to bypass it.
3. Delete the old secrets `NPM_TOKEN`, `PYPI_TOKEN` (and `CARGO_REGISTRY_TOKEN`
   if present) at
   https://github.com/0xcircuitbreaker/DomiNode/settings/secrets/actions and
   under the old `publish` environment, which is no longer used.
4. Only for the optional 1.x deprecation: a short-lived `NPM_TOKEN` secret on
   the `release` environment (see "Deprecating 1.x on npm").
5. Maven consumers need a token with `read:packages` to resolve from
   `https://maven.pkg.github.com/0xcircuitbreaker/DomiNode` (GitHub Packages
   always requires auth for Maven).
