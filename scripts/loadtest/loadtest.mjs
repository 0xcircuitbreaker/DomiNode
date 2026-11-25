#!/usr/bin/env node
// Gateway load/soak harness. See docs/agent-network/CAPACITY.md.
// Dependency-free: node built-ins only (the --mock-nodes mode reuses the
// repo's own built node-agent tunnel client from packages/node-agent/dist).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ArgError, Reservoir, USAGE, buildReport, classifyError, httpConnectErrorClass, meteringAccuracy, parseArgs,
  protocolsFor, renderText, socksErrorClass, splitHostPort, validateConfig,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEAD_LIMIT = 16 * 1024;

function scrub(s) {
  return String(s).replace(/dn_(live|test|node|proxy)_[A-Za-z0-9_-]+/g, 'dn_$1_[REDACTED]');
}

function lgError(cls, message) {
  const e = new Error(message);
  e.lgClass = cls;
  return e;
}

// ─── Sink: reads requestBytes, answers responseBytes, closes ───────────────
function startSink(cfg) {
  const chunk = Buffer.alloc(Math.min(cfg.responseBytes, 64 * 1024) || 1, 0x61);
  const server = net.createServer((sock) => {
    let need = cfg.requestBytes;
    let answered = false;
    sock.on('error', () => {});
    const answer = () => {
      if (answered) return;
      answered = true;
      let left = cfg.responseBytes;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!sock.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void sock.once('drain', pump);
        }
        sock.end();
      };
      pump();
    };
    sock.on('data', (d) => {
      need -= d.length;
      if (need <= 0) answer();
    });
    if (need <= 0) answer();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ─── Mock gateway: pass-through CONNECT + SOCKS5 to the sink ───────────────
function pipeTo(sock, sinkPort, head) {
  const up = net.connect(sinkPort, '127.0.0.1');
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
  if (head && head.length) up.write(head);
  sock.pipe(up).pipe(sock);
}

function startMockGateway(cfg, sinkPort) {
  const http = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return buf.length > HEAD_LIMIT && sock.destroy();
      sock.off('data', onData);
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      pipeTo(sock, sinkPort, buf.subarray(end + 4));
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  const socks = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0) {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          buf = buf.subarray(2 + buf[1]);
          sock.write(Buffer.from([5, 2]));
          stage = 1;
        } else if (stage === 1) {
          if (buf.length < 2) return;
          const ul = buf[1];
          if (buf.length < 3 + ul || buf.length < 3 + ul + buf[2 + ul]) return;
          buf = buf.subarray(3 + ul + buf[2 + ul]);
          sock.write(Buffer.from([1, 0]));
          stage = 2;
        } else {
          if (buf.length < 5) return;
          const len = buf[3] === 3 ? 7 + buf[4] : buf[3] === 1 ? 10 : 22;
          if (buf.length < len) return;
          const rest = buf.subarray(len);
          sock.off('data', onData);
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          pipeTo(sock, sinkPort, rest);
          return;
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  });
  const listen = (srv, port) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, cfg.gateway, () => resolve(srv));
  });
  return Promise.all([listen(http, cfg.httpPort), listen(socks, cfg.socksPort)]);
}

// ─── Mock node agents: real tunnel client, every OPEN dialled to the sink ──
async function startMockNodes(cfg, sinkPort) {
  const files = (process.env.DN_LOADTEST_NODE_KEY_FILES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pins = (process.env.DN_LOADTEST_COORD_PINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!files.length) throw new ArgError('--mock-nodes needs DN_LOADTEST_NODE_KEY_FILES');
  if (!pins.length) throw new ArgError('--mock-nodes needs DN_LOADTEST_COORD_PINS');
  const dist = path.join(ROOT, 'packages', 'node-agent', 'dist', 'src');
  if (!fs.existsSync(path.join(dist, 'tunnel-client.js'))) throw new ArgError('--mock-nodes needs a build (npm run build)');
  const { TunnelClient } = await import(pathToFileURL(path.join(dist, 'tunnel-client.js')).href);
  const { readNodeFile } = await import(pathToFileURL(path.join(dist, 'register.js')).href);
  const { Limits } = await import(pathToFileURL(path.join(dist, 'limits.js')).href);
  const caFile = process.env.DN_LOADTEST_TUNNEL_CA_FILE;
  const wsOptions = caFile ? { ca: fs.readFileSync(caFile) } : undefined;
  const maxStreams = Math.max(cfg.concurrency * 2, 64);
  const quiet = { info: () => {}, warn: (m, meta) => process.stderr.write(`mock-node: ${scrub(m)} ${scrub(JSON.stringify(meta ?? {}))}\n`) };
  const clients = files.map((file) => {
    const stored = readNodeFile(file);
    const client = new TunnelClient({
      url: cfg.tunnelUrl,
      nodeKey: stored.nodeKey,
      nodeId: stored.nodeId,
      agentVersion: 'loadtest-mock',
      localPorts: [80, 443],
      caps: { maxStreams, maxMbps: 0, gbPerDay: 0 },
      limits: new Limits({ maxStreams, reqPerSec: 100_000, gbPerDay: 0 }),
      nodePrivateKeyPem: stored.nodePrivateKeyPem,
      coordPins: pins,
      wsOptions,
      logger: quiet,
      dial: () => new Promise((resolve) => {
        const s = net.connect(sinkPort, '127.0.0.1');
        s.once('connect', () => resolve({ ok: true, socket: s, ip: '127.0.0.1' }));
        s.once('error', () => resolve({ ok: false, code: 'DIAL_FAIL' }));
      }),
    });
    stored.nodeKey = '';
    stored.nodePrivateKeyPem = '';
    return client;
  });
  await Promise.all(clients.map((c) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock node did not reach READY within 30s')), 30_000);
    c.once('ready', () => { clearTimeout(t); resolve(); });
    c.once('authFail', (code) => { clearTimeout(t); reject(new Error(`mock node auth failed: ${code}`)); });
    c.start();
  })));
  return clients;
}

// ─── Clients ───────────────────────────────────────────────────────────────
/** Read until `pred(buf)` returns a value; resolves with { value, rest }. */
function readUntil(sock, pred) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onErr); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      let r;
      try { r = pred(buf); } catch (e) { cleanup(); return reject(e); }
      if (r) { cleanup(); resolve(r); }
    };
    const onEnd = () => { cleanup(); reject(lgError('handshake_closed', 'closed during handshake')); };
    const onErr = (e) => { cleanup(); reject(e); };
    sock.on('data', onData);
    sock.once('end', onEnd);
    sock.once('error', onErr);
  });
}

async function httpHandshake(sock, cfg, target, auth) {
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (auth) lines.push(`Proxy-Authorization: Basic ${auth}`);
  sock.write(lines.join('\r\n') + '\r\n\r\n');
  const { value, rest } = await readUntil(sock, (b) => {
    const end = b.indexOf('\r\n\r\n');
    if (end === -1) {
      if (b.length > HEAD_LIMIT) throw lgError('bad_proxy_reply', 'oversized CONNECT reply');
      return null;
    }
    return { value: b.subarray(0, end).toString('latin1'), rest: b.subarray(end + 4) };
  });
  const m = value.match(/^HTTP\/1\.[01] (\d{3})/);
  if (!m) throw lgError('bad_proxy_reply', 'malformed CONNECT reply');
  if (m[1] !== '200') {
    const code = value.match(/\r\nX-DominusNode-Error:\s*([A-Z0-9_]+)/i);
    throw lgError(httpConnectErrorClass(m[1], code ? code[1].toUpperCase() : ''), `CONNECT ${m[1]}`);
  }
  return rest;
}

async function socksHandshake(sock, cfg, target, user, pass) {
  sock.write(Buffer.from([5, 1, 2]));
  let r = await readUntil(sock, (b) => (b.length >= 2 ? { value: b.subarray(0, 2), rest: b.subarray(2) } : null));
  if (r.value[0] !== 5 || r.value[1] !== 2) throw lgError('socks5_no_auth_method', 'gateway refused user/pass auth');
  const u = Buffer.from(user);
  const p = Buffer.from(pass);
  sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
  r = await readUntil(sock, (b) => (b.length >= 2 ? { value: b.subarray(0, 2), rest: b.subarray(2) } : null));
  if (r.value[1] !== 0) throw lgError('socks5_auth_failed', 'SOCKS5 auth failed');
  const { host, port } = splitHostPort(target);
  const h = Buffer.from(host);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
  r = await readUntil(sock, (b) => {
    if (b.length < 5) return null;
    const len = b[3] === 3 ? 7 + b[4] : b[3] === 4 ? 22 : 10;
    return b.length >= len ? { value: b.subarray(0, len), rest: b.subarray(len) } : null;
  });
  if (r.value[1] !== 0) throw lgError(socksErrorClass(r.value[1]), 'SOCKS5 connect refused');
  return r.rest;
}

/** One tunnel: handshake, push requestBytes, read responseBytes. */
function runTunnel(protocol, cfg, ctx) {
  const t0 = process.hrtime.bigint();
  const ms = (t) => Number(t - t0) / 1e6;
  const port = protocol === 'http' ? cfg.httpPort : cfg.socksPort;
  const res = { connectMs: null, totalMs: null, up: 0, down: 0 };
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, cfg.gateway);
    sock.setNoDelay(true);
    const timer = setTimeout(() => {
      const e = lgError(res.connectMs === null ? 'timeout_handshake' : 'timeout_transfer', 'timeout');
      sock.destroy();
      reject(Object.assign(e, { partial: res }));
    }, cfg.timeout * 1000);
    const fail = (e) => { clearTimeout(timer); sock.destroy(); reject(Object.assign(e, { partial: res })); };
    sock.once('error', fail);
    sock.once('connect', async () => {
      sock.off('error', fail);
      try {
        const rest = protocol === 'http'
          ? await httpHandshake(sock, cfg, cfg.target, ctx.basicAuth)
          : await socksHandshake(sock, cfg, cfg.target, cfg.username, ctx.password);
        res.connectMs = ms(process.hrtime.bigint());
        res.down += rest.length;
        sock.on('error', fail);
        sock.on('data', (d) => { res.down += d.length; });
        sock.once('end', () => {
          clearTimeout(timer);
          res.totalMs = ms(process.hrtime.bigint());
          sock.end();
          if (res.down < cfg.responseBytes) return reject(Object.assign(lgError('short_response', 'short response'), { partial: res }));
          resolve(res);
        });
        let left = cfg.requestBytes;
        const pump = () => {
          while (left > 0) {
            const n = Math.min(left, ctx.payload.length);
            left -= n;
            res.up += n;
            if (!sock.write(n === ctx.payload.length ? ctx.payload : ctx.payload.subarray(0, n))) return void sock.once('drain', pump);
          }
        };
        pump();
      } catch (e) {
        fail(e);
      }
    });
  });
}

// ─── Gateway process sampling (Linux /proc) ────────────────────────────────
export function sampleProc(pid) {
  const s = { t: Date.now(), rssBytes: null, fds: null };
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (m) s.rssBytes = Number(m[1]) * 1024;
  } catch { /* process gone or not Linux */ }
  try {
    s.fds = fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch { /* not permitted */ }
  return s;
}

// ─── Metering ──────────────────────────────────────────────────────────────
async function billedBytesSince(apiUrl, key, since) {
  const url = new URL('/api/usage', apiUrl);
  url.searchParams.set('since', new Date(since).toISOString());
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`usage query failed: HTTP ${res.status}`);
  const body = await res.json();
  const n = Number(body?.summary?.totalBytes);
  if (!Number.isFinite(n)) throw new Error('usage reply has no summary.totalBytes');
  return n;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main(argv) {
  const cfg = parseArgs(argv);
  if (cfg.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const errs = validateConfig(cfg);
  if (errs.length) throw new ArgError(errs.join('\n'));
  const key = process.env.DN_LOADTEST_API_KEY ?? '';
  if (!cfg.mockGateway && !key) throw new ArgError('DN_LOADTEST_API_KEY is required (except with --mock-gateway)');
  if (cfg.apiUrl && !key) throw new ArgError('--api-url needs DN_LOADTEST_API_KEY');

  const notes = [];
  const closers = [];
  const sink = await startSink(cfg);
  closers.push(() => sink.close());
  const sinkPort = sink.address().port;
  if (cfg.mockGateway) {
    const srvs = await startMockGateway(cfg, sinkPort);
    for (const s of srvs) closers.push(() => s.close());
    notes.push('mock gateway: numbers measure the harness and loopback only, not the relay gateway');
  }
  if (cfg.mockNodes) {
    const nodes = await startMockNodes(cfg, sinkPort);
    for (const n of nodes) closers.push(() => n.stop());
    notes.push(`${nodes.length} mock node agent(s) route every OPEN to the local sink`);
  } else if (!cfg.mockGateway) {
    notes.push('no mock nodes: tunnels exit through whatever real nodes the gateway selects');
  }

  const ctx = {
    payload: Buffer.alloc(Math.min(cfg.requestBytes, 64 * 1024) || 1, 0x62),
    password: key,
    basicAuth: key || cfg.mockGateway ? Buffer.from(`${cfg.username}:${key}`).toString('base64') : '',
  };
  const protos = protocolsFor(cfg);
  const fresh = () => ({ ok: 0, errors: {}, connect: new Reservoir(), total: new Reservoir(), bytesUp: 0, bytesDown: 0 });
  const stats = Object.fromEntries(protos.map((p) => [p, fresh()]));
  const samples = [];
  const startedAt = Date.now();
  const deadline = startedAt + cfg.duration * 1000;
  let stopping = false;
  const onSignal = () => { stopping = true; };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const sampler = cfg.gatewayPid ? setInterval(() => samples.push(sampleProc(cfg.gatewayPid)), cfg.sampleInterval * 1000) : null;
  if (cfg.gatewayPid) samples.push(sampleProc(cfg.gatewayPid));

  // Shared open-rate limiter: slots spaced 1/rate apart across all workers.
  let nextSlot = Date.now();
  const waitSlot = async () => {
    if (!cfg.rate) return;
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 1000 / cfg.rate;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };

  const snapshot = (endedAt) => buildReport({
    cfg, startedAt, endedAt, samples, notes, billedBytes: null,
    proto: Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { ...s, connect: s.connect.values, total: s.total.values }])),
  });
  const writeReport = (r) => {
    fs.mkdirSync(path.dirname(path.resolve(cfg.out)), { recursive: true });
    fs.writeFileSync(`${cfg.out}.json`, JSON.stringify(r, null, 2) + '\n');
    fs.writeFileSync(`${cfg.out}.txt`, renderText(r));
  };
  const interim = cfg.soak ? setInterval(() => {
    const r = snapshot(Date.now());
    writeReport(r);
    process.stderr.write(`[soak ${Math.round((Date.now() - startedAt) / 1000)}s] ok=${r.totals.ok} failed=${r.totals.failed} rps=${r.totals.rps}` +
      (r.gateway.rssBytes ? ` rss=${(r.gateway.rssBytes.last / 1048576).toFixed(1)}MiB fds=${r.gateway.fds?.last}` : '') + '\n');
  }, cfg.reportInterval * 1000) : null;

  const worker = async (protocol) => {
    const s = stats[protocol];
    while (!stopping && Date.now() < deadline) {
      await waitSlot();
      if (stopping || Date.now() >= deadline) break;
      try {
        const r = await runTunnel(protocol, cfg, ctx);
        s.ok++;
        s.connect.add(r.connectMs);
        s.total.add(r.totalMs);
        s.bytesUp += r.up;
        s.bytesDown += r.down;
      } catch (e) {
        const cls = classifyError(e);
        s.errors[cls] = (s.errors[cls] ?? 0) + 1;
        if (e.partial) { s.bytesUp += e.partial.up; s.bytesDown += e.partial.down; }
        // Back off briefly on refusals so a dead gateway does not spin the CPU.
        if (cls === 'conn_refused' || cls.startsWith('local_')) await new Promise((r) => setTimeout(r, 100));
      }
    }
  };
  await Promise.all(protos.flatMap((p) => Array.from({ length: cfg.concurrency }, () => worker(p))));
  const endedAt = Date.now();
  if (sampler) clearInterval(sampler);
  if (interim) clearInterval(interim);
  if (cfg.gatewayPid) samples.push(sampleProc(cfg.gatewayPid));

  let billed = null;
  if (cfg.apiUrl) {
    if (cfg.meteringWait) await new Promise((r) => setTimeout(r, cfg.meteringWait * 1000));
    try {
      billed = await billedBytesSince(cfg.apiUrl, key, startedAt - 1000);
      notes.push('billed bytes are all usage for this key since the run started; run with a dedicated key');
    } catch (e) {
      notes.push(`metering read failed: ${scrub(e.message)}`);
    }
  }
  const report = snapshot(endedAt);
  report.metering = meteringAccuracy(report.totals.tunnelBytes, billed);
  writeReport(report);
  process.stdout.write(renderText(report));
  process.stdout.write(`\nReports: ${cfg.out}.json ${cfg.out}.txt\n`);
  for (const c of closers) { try { c(); } catch { /* ignore */ } }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`loadtest: ${scrub(e instanceof ArgError ? e.message : e?.stack ?? e)}\n`);
      if (e instanceof ArgError) process.stderr.write('Run with --help for options.\n');
      process.exit(e instanceof ArgError ? 2 : 1);
    },
  );
}
