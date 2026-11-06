// Run with: node --test scripts/release/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { changelogSection, extractVersion, isPrerelease, levels, loadConfig, plan, registryUrl, tagFor, validateConfig, waitForDeps } from './plan.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relplan-'));
  const w = (f, t) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  };
  w('sdks/node/package.json', JSON.stringify({ name: '@dominusnode/sdk', version: '2.0.0' }));
  w('sdks/python/pyproject.toml', '[project]\nname = "dominusnode"\nversion = "2.1.0rc1"\n');
  w('sdks/go/client.go', 'package x\nconst (\n\tSDKVersion = "2.0.0"\n)\n');
  w('sdks/rust/Cargo.toml', '[package]\nname = "dominusnode"\nversion = "2.0.0"\n[dependencies]\nserde = { version = "1" }\n');
  w('sdks/java/pom.xml', '<project><groupId>io.x</groupId><artifactId>sdk</artifactId>\n<version>2.0.0</version><dependencies><dependency><artifactId>j</artifactId><version>9.9.9</version></dependency></dependencies></project>');
  w('sdks/cpp/CMakeLists.txt', 'project(dominusnode-cpp VERSION 2.0.0 LANGUAGES CXX)\n');
  w('integrations/a/package.json', JSON.stringify({ name: '@dominusnode/a', version: '2.0.1-beta.1' }));
  w('integrations/b/pyproject.toml', '[project]\nname = "dominusnode-b"\nversion = "2.0.0"\n');
  const pk = (id, p, eco, name, file, kind, deps = [], extra = {}) => ({ id, path: p, ecosystem: eco, name, version: { file, kind, ...extra }, dependsOn: deps });
  const config = {
    packages: [
      pk('b', 'integrations/b', 'pypi', 'dominusnode-b', 'pyproject.toml', 'pyproject', ['sdk-python']),
      pk('a', 'integrations/a', 'npm', '@dominusnode/a', 'package.json', 'package-json', ['sdk-node']),
      pk('sdk-node', 'sdks/node', 'npm', '@dominusnode/sdk', 'package.json', 'package-json'),
      pk('sdk-python', 'sdks/python', 'pypi', 'dominusnode', 'pyproject.toml', 'pyproject'),
      pk('sdk-go', 'sdks/go', 'go', 'example/go/v2', 'client.go', 'go-const', [], { const: 'SDKVersion' }),
      pk('sdk-rust', 'sdks/rust', 'crates', 'dominusnode', 'Cargo.toml', 'cargo'),
      pk('sdk-java', 'sdks/java', 'maven', 'io.x:sdk', 'pom.xml', 'pom'),
      pk('sdk-cpp', 'sdks/cpp', 'cpp-release', 'dominusnode-cpp', 'CMakeLists.txt', 'cmake'),
    ],
  };
  return { root, config };
}

function mockFetch(published) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = published.find((p) => url.includes(p));
    if (url.includes('crates.io') && hit) return { status: 200, json: async () => ({ version: { num: '2.0.0' } }) };
    return { status: hit ? 200 : 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

test('extracts versions from every manifest kind', () => {
  assert.equal(extractVersion('pyproject', '[build-system]\nrequires=["x"]\n[project]\nname="a"\nversion = "1.2.3"\n'), '1.2.3');
  assert.equal(extractVersion('cargo', '[package]\nversion = "0.1.0"\n[dependencies]\nx = { version = "9" }'), '0.1.0');
  assert.equal(extractVersion('pom', '<project><parent><artifactId>p</artifactId><version>7</version></parent><artifactId>me</artifactId><version>3.0.0</version></project>'), '3.0.0');
  assert.equal(extractVersion('go-const', 'SDKVersion = "2.3.4"'), '2.3.4');
  assert.equal(extractVersion('cmake', 'project(x\n  VERSION 1.0.0\n  LANGUAGES CXX)'), '1.0.0');
  assert.equal(extractVersion('package-json', '{"version":"5.0.0"}'), '5.0.0');
});

test('pre-release detection', () => {
  for (const v of ['2.1.0-rc.1', '2.0.0-beta', '2.1.0rc1', '2.1.0a2', '2.1.0.dev3']) assert.ok(isPrerelease(v), v);
  for (const v of ['2.0.0', '10.4.1', '2.0.0.post1']) assert.ok(!isPrerelease(v), v);
});

test('tag names and registry URLs', () => {
  assert.equal(tagFor({ id: 'sdk-go', ecosystem: 'go', path: 'sdks/go' }, '2.0.0'), 'sdks/go/v2.0.0');
  assert.equal(tagFor({ id: 'langchain', ecosystem: 'pypi' }, '2.0.0'), 'langchain-v2.0.0');
  assert.equal(registryUrl({ ecosystem: 'npm', name: '@dominusnode/sdk' }, '2.0.0'), 'https://registry.npmjs.org/@dominusnode%2Fsdk/2.0.0');
  assert.equal(registryUrl({ ecosystem: 'pypi', name: 'dominusnode' }, '2.0.0'), 'https://pypi.org/pypi/dominusnode/2.0.0/json');
  assert.equal(registryUrl({ ecosystem: 'crates', name: 'dominusnode' }, '2.0.0'), 'https://crates.io/api/v1/crates/dominusnode/2.0.0');
  assert.equal(registryUrl({ ecosystem: 'maven', name: 'x' }, '2.0.0'), undefined);
});

test('nothing published: everything planned, SDKs before dependents', async () => {
  const { root, config } = fixture();
  const r = await plan({ root, config, fetchImpl: mockFetch([]), tags: new Set() });
  assert.equal(r.release.length, 8);
  assert.ok(r.release.indexOf('sdk-node') < r.release.indexOf('a'));
  assert.ok(r.release.indexOf('sdk-python') < r.release.indexOf('b'));
  assert.deepEqual(r.matrix.npm_0.map((e) => e.id), ['sdk-node']);
  assert.deepEqual(r.matrix.npm_1.map((e) => e.id), ['a']);
  assert.deepEqual(r.matrix.pypi_0.map((e) => e.id), ['sdk-python']);
  assert.deepEqual(r.matrix.pypi_1.map((e) => e.id), ['b']);
  for (const k of ['go', 'crates', 'maven', 'cpp']) assert.equal(r.matrix[k].length, 1, k);
  const a = r.matrix.npm_1[0];
  assert.equal(a.prerelease, true);
  assert.equal(a.npmTag, 'next');
  assert.equal(r.matrix.npm_0[0].npmTag, 'latest');
  assert.equal(r.matrix.pypi_0[0].prerelease, true);
});

test('published and tagged packages are skipped; published-but-untagged only needs a tag', async () => {
  const { root, config } = fixture();
  const fetchImpl = mockFetch(['%2Fsdk/2.0.0', 'pypi/dominusnode/2.1.0rc1', 'crates.io']);
  const tags = new Set(['sdk-node-v2.0.0', 'sdks/go/v2.0.0', 'sdk-java-v2.0.0', 'sdk-cpp-v2.0.0']);
  const r = await plan({ root, config, fetchImpl, tags });
  assert.deepEqual(r.release.sort(), ['a', 'b', 'sdk-python', 'sdk-rust']);
  const py = r.packages.find((e) => e.id === 'sdk-python');
  assert.equal(py.published, true);
  assert.equal(py.tagged, false);
  assert.equal(r.matrix.go.length, 0);
});

test('--only restricts the plan and --all includes up-to-date packages', async () => {
  const { root, config } = fixture();
  const r = await plan({ root, config, fetchImpl: mockFetch([]), tags: new Set(), only: 'b' });
  assert.deepEqual(r.release, ['b']);
  const all = await plan({ root, config, fetchImpl: mockFetch(['registry', 'pypi', 'crates']), tags: new Set(['sdk-node-v2.0.0', 'a-v2.0.1-beta.1', 'sdk-python-v2.1.0rc1', 'b-v2.0.0', 'sdk-rust-v2.0.0', 'sdks/go/v2.0.0', 'sdk-java-v2.0.0', 'sdk-cpp-v2.0.0']), all: true });
  assert.equal(all.release.length, 8);
  assert.ok(all.packages.every((e) => !e.release));
  await assert.rejects(plan({ root, config, fetchImpl: mockFetch([]), tags: new Set(), only: 'nope' }), /unknown package/);
});

test('registry errors fail the plan instead of guessing', async () => {
  const { root, config } = fixture();
  const fetchImpl = async () => ({ status: 503 });
  await assert.rejects(plan({ root, config, fetchImpl, tags: new Set() }), /HTTP 503/);
});

test('config validation and cycles', () => {
  assert.throws(() => validateConfig({ packages: [{ id: 'x', path: 'p', ecosystem: 'npm', name: 'n', version: {}, dependsOn: ['y'] }] }), /unknown package/);
  assert.throws(() => validateConfig({ packages: [{ id: 'x', path: 'p', ecosystem: 'apt', name: 'n', version: {} }] }), /unknown ecosystem/);
  assert.throws(() => levels([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /cycle/);
});

test('changelog section extraction handles the heading styles in the repo', () => {
  const text = '# Changelog\n\n## [2.0.0] - 2026-11-06\n\n- New\n\n## 1.0.1\n- Old\n\n[1.0.0]: https://x\n';
  assert.equal(changelogSection(text, '2.0.0'), '- New');
  assert.equal(changelogSection('## 2.0.0 (2026-11-06)\n- A\n## 1.0.0\n', '2.0.0'), '- A');
  assert.equal(changelogSection('## 2.0.0\n- B\n', '2.0.0'), '- B');
  assert.equal(changelogSection('## 2.0.01\n- no\n', '2.0.0'), undefined);
});

test('wait polls until the dependency appears', async () => {
  const { root, config } = fixture();
  let n = 0;
  const fetchImpl = async () => ({ status: ++n >= 3 ? 200 : 404 });
  await waitForDeps(config.packages[1], config, { root, fetchImpl, timeoutSec: 60, sleep: async () => {} });
  assert.equal(n, 3);
  await assert.rejects(waitForDeps(config.packages[1], config, { root, fetchImpl: async () => ({ status: 404 }), timeoutSec: 0, sleep: async () => {} }), /not on the registry/);
});

test('the real config is valid and every manifest version is readable', async () => {
  const config = loadConfig();
  const r = await plan({ config, fetchImpl: mockFetch([]), tags: new Set() });
  assert.equal(r.packages.length, config.packages.length);
  assert.equal(r.packages.filter((e) => e.ecosystem === 'npm').length, 11);
  assert.equal(r.packages.filter((e) => e.ecosystem === 'pypi').length, 21);
  for (const e of r.packages.filter((x) => x.ecosystem === 'npm' && x.id !== 'sdk-node' && x.id !== 'mcp-server')) {
    const pj = JSON.parse(fs.readFileSync(path.join(process.cwd(), e.path, 'package.json'), 'utf8'));
    assert.equal(pj.dependencies['@dominusnode/sdk'], '^2.0.0', e.id);
    assert.equal(pj.repository.url, 'git+https://github.com/0xcircuitbreaker/DomiNode.git', e.id);
  }
});
