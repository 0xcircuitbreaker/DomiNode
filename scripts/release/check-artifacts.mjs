#!/usr/bin/env node
// Release artifact check. Zero dependencies (Node >= 20).
//
// Lists what a package artifact actually contains and fails when it ships
// something it should not: tests, fixtures, secrets, .env files, source maps,
// node_modules, build/cache debris, or files above a size ceiling.
//
// Usage:
//   node scripts/release/check-artifacts.mjs [--max-total <bytes>] [--max-file <bytes>] [--list] <artifact>...
//
// An artifact is one of:
//   *.json            output of `npm pack --dry-run --json` (npm; contents are read from disk next to it via --root)
//   *.tgz / *.tar.gz  npm tarball, Python sdist, C++ source archive
//   *.crate           cargo package output (gzip tar)
//   *.whl / *.jar     zip archives
// For `npm pack --dry-run --json` output pass `--root <package dir>` so file
// contents can be scanned for secrets.
//
// See docs/RELEASING.md ("Artifact check").

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MAX_TOTAL = 5 * 1024 * 1024; // unpacked bytes per artifact
export const DEFAULT_MAX_FILE = 1024 * 1024; // bytes per file

// Path rules, matched against the path inside the artifact with any single
// top-level directory (sdist "name-1.0/", npm "package/") removed.
export const FORBIDDEN = [
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)(tests?|__tests__|spec|fixtures?|testdata|__mocks__)\//, 'tests/fixtures'],
  [/(^|\/)(test_[^/]*|[^/]*_test)\.py$/, 'test module'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'test file'],
  [/(^|\/)conftest\.py$/, 'pytest conftest'],
  [/\.map$/, 'source map'],
  [/(^|\/)\.env($|\.)/, '.env file'],
  [/(^|\/)\.(npmrc|pypirc|netrc)$/, 'registry credentials file'],
  [/\.(pem|key|p12|pfx|jks|keystore)$/, 'key material'],
  [/(^|\/)id_(rsa|ed25519|ecdsa)/, 'ssh key'],
  [/(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.venv|venv|coverage|\.nyc_output|\.git|\.github|\.vscode|\.idea)\//, 'cache / tooling directory'],
  [/\.(pyc|pyo|log|tgz|swp|rej|bak|tmp)$|~$/, 'scratch / build debris'],
  [/(^|\/)(?!Cargo\.toml\.orig$)[^/]*\.orig$/, 'scratch / build debris'], // cargo itself writes Cargo.toml.orig
  [/(^|\/)\.DS_Store$/, 'scratch / build debris'],
  [/(^|\/)(tmp|scratch)\//, 'scratch directory'],
  [/(^|\/)(tsconfig[^/]*\.json|vitest\.config\.[^/]+|jest\.config\.[^/]+|\.eslintrc[^/]*|\.prettierrc[^/]*)$/, 'dev config'],
];

// Secrets in file contents. Placeholders such as dn_live_KEY or dn_live_xxx are fine.
export const SECRET_PATTERNS = [
  [/\bdn_(live|test|node|proxy)_[A-Za-z0-9]{24,}/, 'DominusNode API key'],
  [/-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, 'private key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bpypi-AgE[A-Za-z0-9_-]{50,}/, 'PyPI token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
];
const PRIVKEY_ASSIGN = /(private[_-]?key|PRIVATE_KEY|secret)["']?\s*[:=]\s*["']0x[0-9a-fA-F]{64}["']/;

export function stripTopDir(paths) {
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  if (tops.size === 1 && paths.every((p) => p.includes('/'))) {
    return paths.map((p) => p.slice(p.indexOf('/') + 1));
  }
  return paths;
}

/** Problems for one artifact: [{ path, reason }]. `files` = [{ path, size, data? }]. */
export function checkFiles(files, { maxTotal = DEFAULT_MAX_TOTAL, maxFile = DEFAULT_MAX_FILE, kind = '' } = {}) {
  const problems = [];
  const rel = stripTopDir(files.map((f) => f.path));
  let total = 0;
  files.forEach((f, i) => {
    const p = rel[i];
    total += f.size;
    // setuptools writes <name>.egg-info/ at the sdist root as metadata; anywhere else (or in a wheel) it is debris.
    if (/(^|\/)[^/]+\.egg-info(\/|$)/.test(p) && !(kind === 'sdist' && /^[^/]+\.egg-info\//.test(p) && !p.includes('/', p.indexOf('/') + 1))) {
      problems.push({ path: f.path, reason: 'egg-info' });
    }
    for (const [re, reason] of FORBIDDEN) if (re.test(p)) problems.push({ path: f.path, reason });
    if (f.size > maxFile) problems.push({ path: f.path, reason: `file is ${f.size} bytes (> ${maxFile})` });
    if (f.data && f.size <= maxFile) {
      const text = f.data.toString('latin1');
      for (const [re, reason] of SECRET_PATTERNS) if (re.test(text)) problems.push({ path: f.path, reason });
      if (PRIVKEY_ASSIGN.test(text)) problems.push({ path: f.path, reason: 'hex private key assignment' });
    }
  });
  if (total > maxTotal) problems.push({ path: '(total)', reason: `${total} bytes unpacked (> ${maxTotal})` });
  return { problems, total, count: files.length };
}

// ---------------------------------------------------------------- readers

export function readTar(buf) {
  const files = [];
  let off = 0;
  let longName;
  let paxPath;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') { const m = body.toString('utf8').match(/\d+ path=([^\n]+)\n/); paxPath = m && m[1]; continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = undefined; }
    if (paxPath) { name = paxPath; paxPath = undefined; }
    if (type === '0' || type === '\0' || type === '7') files.push({ path: name, size, data: Buffer.from(body) });
    else if (type === '1' || type === '2') files.push({ path: name, size: 0 });
  }
  return files;
}

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    try {
      data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : undefined;
    } catch {
      data = undefined;
    }
    files.push({ path: name, size: usize, data });
  }
  return files;
}

export function readArtifact(file, { root } = {}) {
  const base = path.basename(file);
  if (base.endsWith('.json')) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = Array.isArray(j) ? j[0] : j;
    if (!entry || !Array.isArray(entry.files)) throw new Error(`${file}: not npm pack --json output`);
    const dir = root ?? path.dirname(file);
    return {
      kind: 'npm',
      name: `${entry.name}@${entry.version}`,
      files: entry.files.map((f) => {
        const abs = path.join(dir, f.path);
        return { path: f.path, size: f.size, data: fs.existsSync(abs) ? fs.readFileSync(abs) : undefined };
      }),
    };
  }
  const buf = fs.readFileSync(file);
  if (/\.(tgz|tar\.gz|crate)$/.test(base)) {
    const kind = base.endsWith('.crate') ? 'crate' : /\.tgz$/.test(base) ? 'npm' : 'sdist';
    return { kind, name: base, files: readTar(zlib.gunzipSync(buf)) };
  }
  if (/\.(whl|jar|zip)$/.test(base)) return { kind: 'wheel', name: base, files: readZip(buf) };
  throw new Error(`${file}: unknown artifact type`);
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const opts = { maxTotal: DEFAULT_MAX_TOTAL, maxFile: DEFAULT_MAX_FILE };
  const inputs = [];
  let list = false;
  let root;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-total' || a === '--max-file') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) throw new Error(`${a} must be a positive integer`);
      opts[a === '--max-total' ? 'maxTotal' : 'maxFile'] = v;
    } else if (a === '--root') root = argv[++i];
    else if (a === '--list') list = true;
    else inputs.push(a);
  }
  if (!inputs.length) throw new Error('no artifacts given');
  let failed = false;
  for (const file of inputs) {
    const art = readArtifact(file, { root });
    const r = checkFiles(art.files, { ...opts, kind: art.kind });
    process.stdout.write(`${art.name}: ${r.count} files, ${r.total} bytes\n`);
    if (list) for (const f of art.files) process.stdout.write(`  ${String(f.size).padStart(9)}  ${f.path}\n`);
    for (const p of r.problems) {
      failed = true;
      process.stdout.write(`::error::${art.name}: ${p.path}: ${p.reason}\n`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`check-artifacts: ${e.message}\n`);
    process.exit(2);
  }
}
