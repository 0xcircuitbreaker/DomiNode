#!/usr/bin/env node
// Release planner. Zero dependencies (Node >= 20).
//
// For every package in .github/release-packages.json it reads the manifest
// version, checks whether that exact version is already published (and
// tagged), and prints the packages that still need releasing, grouped into
// per-ecosystem matrices in dependency order. See docs/RELEASING.md.
//
// Usage:
//   node scripts/release/plan.mjs [--only <id>] [--github-output] [--all]
//   node scripts/release/plan.mjs notes <id>          # CHANGELOG section for the current version
//   node scripts/release/plan.mjs wait <id> [--timeout <sec>]
//                                                     # wait until <id>'s dependencies are visible on their registry

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_PATH = '.github/release-packages.json';
export const ECOSYSTEMS = ['npm', 'pypi', 'go', 'crates', 'maven', 'cpp-release'];
const LEVELED = new Set(['npm', 'pypi']);
const MAX_LEVEL = 1;

export function loadConfig(root = REPO_ROOT) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, CONFIG_PATH), 'utf8'));
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.packages)) throw new Error('config: "packages" must be an array');
  const ids = new Set();
  for (const p of cfg.packages) {
    for (const k of ['id', 'path', 'ecosystem', 'name', 'version']) {
      if (!p[k]) throw new Error(`config: package ${p.id ?? '?'} is missing "${k}"`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) throw new Error(`config: bad id "${p.id}"`);
    if (ids.has(p.id)) throw new Error(`config: duplicate id "${p.id}"`);
    if (!ECOSYSTEMS.includes(p.ecosystem)) throw new Error(`config: ${p.id}: unknown ecosystem "${p.ecosystem}"`);
    ids.add(p.id);
  }
  for (const p of cfg.packages) {
    for (const d of p.dependsOn ?? []) {
      if (!ids.has(d)) throw new Error(`config: ${p.id} depends on unknown package "${d}"`);
    }
  }
}

// ---------------------------------------------------------------- versions

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PEP440 = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

export function extractVersion(kind, text, opts = {}) {
  let m;
  switch (kind) {
    case 'package-json':
      return JSON.parse(text).version;
    case 'pyproject':
      m = text.match(/^\[project\][^[]*?^version\s*=\s*["']([^"']+)["']/ms);
      break;
    case 'cargo':
      m = text.match(/^\[package\][^[]*?^version\s*=\s*["']([^"']+)["']/ms);
      break;
    case 'pom': {
      // The project's own <version>, not the parent's or a dependency's.
      const noParent = text.replace(/<parent>[\s\S]*?<\/parent>/, '');
      const head = noParent.split(/<(?:dependencies|dependencyManagement|build|profiles)>/)[0];
      m = head.match(/<artifactId>[^<]+<\/artifactId>\s*<version>([^<]+)<\/version>/);
      break;
    }
    case 'go-const': {
      const name = opts.const ?? 'SDKVersion';
      m = text.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`));
      break;
    }
    case 'cmake':
      m = text.match(/project\s*\([^)]*?\bVERSION\s+([0-9][0-9A-Za-z.-]*)/s);
      break;
    default:
      throw new Error(`unknown version kind "${kind}"`);
  }
  return m ? m[1] : undefined;
}

export function readVersion(pkg, root = REPO_ROOT) {
  const file = path.join(root, pkg.path, pkg.version.file);
  const v = extractVersion(pkg.version.kind, fs.readFileSync(file, 'utf8'), pkg.version);
  if (!v) throw new Error(`${pkg.id}: could not read version from ${path.join(pkg.path, pkg.version.file)}`);
  const ok = pkg.ecosystem === 'pypi' ? PEP440.test(v) || SEMVER.test(v) : SEMVER.test(v);
  if (!ok) throw new Error(`${pkg.id}: "${v}" is not a valid version`);
  return v;
}

/** Semver pre-release ("2.1.0-rc.1") or PEP 440 pre/dev release ("2.1.0rc1"). */
export function isPrerelease(v) {
  return v.includes('-') || /\d(?:a|b|rc)\d+/.test(v) || /\.dev\d+/.test(v);
}

export function tagFor(pkg, version) {
  return pkg.ecosystem === 'go' ? `${pkg.path}/v${version}` : `${pkg.id}-v${version}`;
}

// ---------------------------------------------------------------- registries

const UA = 'dominusnode-release-planner (+https://github.com/0xcircuitbreaker/DomiNode)';

export function registryUrl(pkg, version) {
  switch (pkg.ecosystem) {
    case 'npm':
      return `https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
    case 'pypi':
      return `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}/json`;
    case 'crates':
      return `https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`;
    default:
      return undefined; // published == tag exists
  }
}

/** true = published, false = not published. Throws on anything other than 200/404. */
export async function isPublished(pkg, version, { fetchImpl = globalThis.fetch, tags } = {}) {
  const url = registryUrl(pkg, version);
  if (!url) return tags.has(tagFor(pkg, version));
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'follow' });
      if (res.status === 200) {
        if (pkg.ecosystem === 'crates') {
          const body = await res.json();
          return Boolean(body && body.version && body.version.num === version);
        }
        return true;
      }
      if (res.status === 404) return false;
      lastErr = new Error(`${pkg.id}: ${url} returned HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function remoteTags(remote = 'origin', cwd = REPO_ROOT) {
  const out = execFileSync('git', ['ls-remote', '--tags', '--refs', remote], { cwd, encoding: 'utf8' });
  return new Set(
    out
      .split('\n')
      .map((l) => l.split('\t')[1])
      .filter(Boolean)
      .map((r) => r.replace(/^refs\/tags\//, '')),
  );
}

// ---------------------------------------------------------------- ordering

/** Depth of each package in the dependency graph (0 = no deps). Throws on cycles. */
export function levels(packages) {
  const byId = new Map(packages.map((p) => [p.id, p]));
  const memo = new Map();
  const visit = (id, stack) => {
    if (memo.has(id)) return memo.get(id);
    if (stack.includes(id)) throw new Error(`dependency cycle: ${[...stack, id].join(' -> ')}`);
    const deps = byId.get(id).dependsOn ?? [];
    const lvl = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, [...stack, id]))) : 0;
    memo.set(id, lvl);
    return lvl;
  };
  for (const p of packages) visit(p.id, []);
  return memo;
}

export function topoSort(packages) {
  const lv = levels(packages);
  return [...packages].sort((a, b) => lv.get(a.id) - lv.get(b.id) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- plan

export async function plan({ root = REPO_ROOT, config, fetchImpl = globalThis.fetch, tags, only, all = false } = {}) {
  config ??= loadConfig(root);
  validateConfig(config);
  tags ??= remoteTags('origin', root);
  if (only && !config.packages.some((p) => p.id === only)) throw new Error(`unknown package id "${only}"`);
  const lv = levels(config.packages);

  const entries = await Promise.all(
    topoSort(config.packages).map(async (p) => {
      const version = readVersion(p, root);
      const tag = tagFor(p, version);
      const tagged = tags.has(tag);
      const published = await isPublished(p, version, { fetchImpl, tags });
      const level = lv.get(p.id);
      if (level > MAX_LEVEL || (level > 0 && !LEVELED.has(p.ecosystem))) {
        throw new Error(`${p.id}: dependency depth ${level} is not supported by release.yml`);
      }
      const prerelease = isPrerelease(version);
      return {
        id: p.id,
        path: p.path,
        ecosystem: p.ecosystem,
        name: p.name,
        version,
        tag,
        prerelease,
        npmTag: prerelease ? 'next' : 'latest',
        level,
        dependsOn: p.dependsOn ?? [],
        install: p.install,
        build: p.build,
        test: p.test,
        published,
        tagged,
        release: !published || !tagged,
      };
    }),
  );

  const selected = entries.filter((e) => (only ? e.id === only : true) && (all || e.release));
  const matrix = {};
  for (const eco of ECOSYSTEMS) {
    const key = eco.replace('-release', '');
    if (LEVELED.has(eco)) {
      for (let l = 0; l <= MAX_LEVEL; l++) matrix[`${key}_${l}`] = selected.filter((e) => e.ecosystem === eco && e.level === l);
    } else {
      matrix[key] = selected.filter((e) => e.ecosystem === eco);
    }
  }
  return { packages: entries, release: selected.map((e) => e.id), matrix };
}

// ---------------------------------------------------------------- changelog

export function changelogSection(text, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+\\[?v?${esc}\\]?(?=[\\s(]|$)`);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && (/^##\s/.test(l) || /^\[[^\]]+\]:\s/.test(l)));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

export function releaseNotes(pkg, version, root = REPO_ROOT) {
  const file = path.join(root, pkg.path, 'CHANGELOG.md');
  const fallback = `${pkg.name} ${version}\n\nSee ${pkg.path}/CHANGELOG.md.`;
  if (!fs.existsSync(file)) return fallback;
  return changelogSection(fs.readFileSync(file, 'utf8'), version) || fallback;
}

// ---------------------------------------------------------------- wait

export async function waitForDeps(pkg, config, { root = REPO_ROOT, fetchImpl = globalThis.fetch, timeoutSec = 600, intervalSec = 15, sleep } = {}) {
  sleep ??= (ms) => new Promise((r) => setTimeout(r, ms));
  const deps = (pkg.dependsOn ?? []).map((d) => config.packages.find((p) => p.id === d));
  const deadline = Date.now() + timeoutSec * 1000;
  for (const dep of deps) {
    const v = readVersion(dep, root);
    for (;;) {
      if (await isPublished(dep, v, { fetchImpl, tags: new Set() })) break;
      if (Date.now() >= deadline) throw new Error(`${pkg.id}: ${dep.name}@${v} is not on the registry after ${timeoutSec}s`);
      await sleep(intervalSec * 1000);
    }
  }
}

// ---------------------------------------------------------------- CLI

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const config = loadConfig();
  if (argv[0] === 'notes' || argv[0] === 'wait') {
    const pkg = config.packages.find((p) => p.id === argv[1]);
    if (!pkg) throw new Error(`unknown package id "${argv[1]}"`);
    if (argv[0] === 'notes') {
      process.stdout.write(releaseNotes(pkg, readVersion(pkg)) + '\n');
    } else {
      const t = Number(arg(argv, '--timeout') ?? 600);
      if (!Number.isFinite(t) || t < 0 || t > 3600) throw new Error('--timeout must be 0..3600');
      await waitForDeps(pkg, config, { timeoutSec: t });
    }
    return;
  }
  const result = await plan({ config, only: arg(argv, '--only') || undefined, all: argv.includes('--all') });
  if (argv.includes('--github-output')) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error('GITHUB_OUTPUT is not set');
    const lines = [`release=${JSON.stringify(result.release)}`];
    for (const [k, v] of Object.entries(result.matrix)) lines.push(`${k}=${JSON.stringify(v)}`);
    fs.appendFileSync(out, lines.join('\n') + '\n');
  }
  const summary = result.packages.map((e) => ({
    id: e.id,
    ecosystem: e.ecosystem,
    version: e.version,
    published: e.published,
    tagged: e.tagged,
    action: e.release ? (e.published ? 'tag+release' : 'publish') : 'up-to-date',
  }));
  process.stdout.write(JSON.stringify({ release: result.release, packages: summary }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`plan: ${e.message}\n`);
    process.exit(1);
  });
}
