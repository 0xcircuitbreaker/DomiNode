// Run with: node --test scripts/release/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

import { checkFiles, readArtifact, readTar } from './check-artifacts.mjs';

const f = (p, size = 10, data) => ({ path: p, size, data: data === undefined ? undefined : Buffer.from(data) });
const reasons = (files, opts) => checkFiles(files, opts).problems.map((p) => `${p.path}: ${p.reason}`);

test('clean npm and wheel contents pass', () => {
  assert.deepEqual(reasons([f('package/package.json'), f('package/README.md', 10, 'use dn_live_KEY'), f('package/dist/index.js'), f('package/dist/index.d.ts')]), []);
  assert.deepEqual(reasons([f('dominusnode/__init__.py'), f('dominusnode-2.0.0.dist-info/METADATA')], { kind: 'wheel' }), []);
});

test('forbidden paths fail', () => {
  const bad = [
    'package/node_modules/x/index.js',
    'pkg-1.0/tests/test_core.py',
    'package/dist/index.js.map',
    'package/.env',
    'package/.env.local',
    'package/src/a.test.ts',
    'pkg-1.0/conftest.py',
    'pkg-1.0/pkg/__pycache__/a.cpython-312.pyc',
    'package/fixtures/keys.json',
    'package/key.pem',
    'package/.npmrc',
    'package/tsconfig.json',
    'package/debug.log',
  ];
  for (const p of bad) assert.ok(reasons([f(p), f('package/x')]).length > 0, p);
});

test('egg-info allowed only at the sdist root', () => {
  assert.deepEqual(reasons([f('pkg-1.0/pkg.egg-info/PKG-INFO'), f('pkg-1.0/pkg/__init__.py')], { kind: 'sdist' }), []);
  assert.ok(reasons([f('pkg.egg-info/PKG-INFO'), f('pkg/__init__.py')], { kind: 'wheel' }).length);
  assert.ok(reasons([f('pkg-1.0/pkg/sub.egg-info/PKG-INFO'), f('pkg-1.0/x')], { kind: 'sdist' }).length);
});

test('secrets in contents and size ceilings fail', () => {
  assert.ok(reasons([f('package/dist/a.js', 40, 'k="dn_live_' + 'a'.repeat(32) + '"'), f('package/x')]).some((r) => r.includes('API key')));
  assert.ok(reasons([f('package/a', 40, '-----BEGIN PRIVATE KEY-----'), f('package/x')]).some((r) => r.includes('private key')));
  assert.ok(reasons([f('package/a', 40, 'PRIVATE_KEY = "0x' + 'ab'.repeat(32) + '"'), f('package/x')]).length);
  assert.ok(reasons([f('package/big', 2000), f('package/x')], { maxFile: 1000 }).some((r) => r.includes('> 1000')));
  assert.ok(reasons([f('package/a', 600), f('package/b', 600)], { maxTotal: 1000 }).some((r) => r.startsWith('(total)')));
});

function tarEntry(name, body) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write('0000644\0', 100);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('0', 156);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  Buffer.from(body).copy(pad);
  return Buffer.concat([h, pad]);
}

test('reads tar.gz artifacts', () => {
  const tar = Buffer.concat([tarEntry('pkg-1.0/pkg/__init__.py', 'x = 1\n'), tarEntry('pkg-1.0/tests/test_a.py', 'pass\n'), Buffer.alloc(1024)]);
  assert.deepEqual(readTar(tar).map((e) => [e.path, e.size]), [['pkg-1.0/pkg/__init__.py', 6], ['pkg-1.0/tests/test_a.py', 5]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chkart-'));
  const file = path.join(dir, 'pkg-1.0.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(tar));
  const art = readArtifact(file);
  assert.equal(art.kind, 'sdist');
  assert.ok(checkFiles(art.files, { kind: art.kind }).problems.some((p) => p.reason === 'tests/fixtures'));
});

test('reads npm pack --json output with contents from --root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chkart-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist/index.js'), 'export {}');
  const json = path.join(dir, 'pack.json');
  fs.writeFileSync(json, JSON.stringify([{ name: '@x/y', version: '2.0.0', files: [{ path: 'dist/index.js', size: 9 }, { path: 'package.json', size: 2 }] }]));
  const art = readArtifact(json, { root: dir });
  assert.equal(art.name, '@x/y@2.0.0');
  assert.equal(art.files[0].data.toString(), 'export {}');
});
