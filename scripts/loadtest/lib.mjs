// Pure helpers for the gateway load/soak harness: argument parsing and
// validation, latency statistics, error classification and report rendering.
// No I/O here so it can be unit tested (scripts/loadtest/lib.test.mjs).
import net from 'node:net';

export const PROTOCOLS = ['http', 'socks5'];

export const DEFAULTS = Object.freeze({
  gateway: '127.0.0.1',
  httpPort: 8080,
  socksPort: 1080,
  protocol: 'both',
  concurrency: 10,
  rate: 0,
  duration: 30,
  soak: false,
  soakDuration: 3600,
  sampleInterval: 1,
  reportInterval: 60,
  requestBytes: 1024,
  responseBytes: 16384,
  target: 'loadtest.example.org:443',
  username: 'relay',
  timeout: 30,
  mockGateway: false,
  mockNodes: false,
  tunnelUrl: '',
  gatewayPid: 0,
  apiUrl: '',
  meteringWait: 15,
  allowRemote: false,
  out: 'loadtest-report',
});

const MAX_CONCURRENCY = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DURATION = 7 * 24 * 3600;

const FLAGS = {
  '--gateway': ['gateway', 'string'],
  '--http-port': ['httpPort', 'int'],
  '--socks-port': ['socksPort', 'int'],
  '--protocol': ['protocol', 'string'],
  '--concurrency': ['concurrency', 'int'],
  '--rate': ['rate', 'number'],
  '--duration': ['duration', 'number'],
  '--soak': ['soak', 'bool'],
  '--sample-interval': ['sampleInterval', 'number'],
  '--report-interval': ['reportInterval', 'number'],
  '--request-bytes': ['requestBytes', 'int'],
  '--response-bytes': ['responseBytes', 'int'],
  '--target': ['target', 'string'],
  '--username': ['username', 'string'],
  '--timeout': ['timeout', 'number'],
  '--mock-gateway': ['mockGateway', 'bool'],
  '--mock-nodes': ['mockNodes', 'bool'],
  '--tunnel-url': ['tunnelUrl', 'string'],
  '--gateway-pid': ['gatewayPid', 'int'],
  '--api-url': ['apiUrl', 'string'],
  '--metering-wait': ['meteringWait', 'number'],
  '--allow-remote': ['allowRemote', 'bool'],
  '--out': ['out', 'string'],
};

export class ArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
  }
}

/** Parse argv (without node + script) into a config object. Throws ArgError. */
export function parseArgs(argv) {
  const cfg = { ...DEFAULTS, help: false };
  let durationSet = false;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      cfg.help = true;
      continue;
    }
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const spec = FLAGS[arg];
    if (!spec) throw new ArgError(`unknown option: ${arg}`);
    const [key, type] = spec;
    if (key === 'duration') durationSet = true;
    if (type === 'bool') {
      if (value !== undefined && value !== 'true' && value !== 'false') throw new ArgError(`${arg} takes no value`);
      cfg[key] = value !== 'false';
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new ArgError(`${arg} needs a value`);
      value = argv[++i];
    }
    if (type === 'string') cfg[key] = value;
    else {
      const n = Number(value);
      if (value === '' || !Number.isFinite(n)) throw new ArgError(`${arg} must be a number`);
      if (type === 'int' && !Number.isInteger(n)) throw new ArgError(`${arg} must be an integer`);
      cfg[key] = n;
    }
  }
  if (cfg.soak && !durationSet) cfg.duration = DEFAULTS.soakDuration;
  return cfg;
}

/** True for loopback/private/link-local literals and localhost names. */
export function isLocalHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const v = net.isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (v === 6) {
    if (h === '::1') return true;
    if (h.startsWith('::ffff:')) return isLocalHost(h.slice(7));
    return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  }
  return false;
}

/** Split host:port (IPv6 bracketed). Returns null when malformed. */
export function splitHostPort(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\[[0-9a-fA-F:.]+\]|[^:[\]\s]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].startsWith('[') ? m[1].slice(1, -1) : m[1], port };
}

function hostOfUrl(u, name) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new ArgError(`${name} is not a valid URL`);
  }
  return { url, host: url.hostname };
}

/** Validate a parsed config. Returns a list of problems (empty = ok). */
export function validateConfig(cfg) {
  const errs = [];
  const intIn = (k, lo, hi, name) => {
    if (!Number.isInteger(cfg[k]) || cfg[k] < lo || cfg[k] > hi) errs.push(`${name} must be an integer in [${lo}, ${hi}]`);
  };
  const numIn = (k, lo, hi, name) => {
    if (!Number.isFinite(cfg[k]) || cfg[k] < lo || cfg[k] > hi) errs.push(`${name} must be in [${lo}, ${hi}]`);
  };
  if (!['http', 'socks5', 'both'].includes(cfg.protocol)) errs.push('--protocol must be http, socks5 or both');
  intIn('httpPort', 1, 65535, '--http-port');
  intIn('socksPort', 1, 65535, '--socks-port');
  intIn('concurrency', 1, MAX_CONCURRENCY, '--concurrency');
  numIn('rate', 0, 1_000_000, '--rate');
  numIn('duration', 1, MAX_DURATION, '--duration');
  numIn('sampleInterval', 0.1, 3600, '--sample-interval');
  numIn('reportInterval', 1, 86400, '--report-interval');
  intIn('requestBytes', 0, MAX_BYTES, '--request-bytes');
  intIn('responseBytes', 0, MAX_BYTES, '--response-bytes');
  numIn('timeout', 1, 600, '--timeout');
  numIn('meteringWait', 0, 600, '--metering-wait');
  if (!Number.isInteger(cfg.gatewayPid) || cfg.gatewayPid < 0) errs.push('--gateway-pid must be a non-negative integer');
  if (!splitHostPort(cfg.target)) errs.push('--target must be host:port');
  if (typeof cfg.username !== 'string' || !/^[A-Za-z0-9-]{1,255}$/.test(cfg.username)) {
    errs.push('--username must be gateway flags joined by hyphens (e.g. relay, country-US-class-dc)');
  }
  if (typeof cfg.out !== 'string' || cfg.out === '' || /[\0]/.test(cfg.out)) errs.push('--out must be a file prefix');
  if (cfg.mockGateway && cfg.mockNodes) errs.push('--mock-gateway and --mock-nodes cannot be combined');
  if (cfg.mockNodes && !cfg.tunnelUrl) errs.push('--mock-nodes needs --tunnel-url (the gateway node tunnel, wss://...)');

  // Local-only guard: every endpoint the harness talks to must be local unless --allow-remote.
  const endpoints = [['--gateway', cfg.gateway]];
  for (const [name, u] of [['--tunnel-url', cfg.tunnelUrl], ['--api-url', cfg.apiUrl]]) {
    if (!u) continue;
    try {
      const { url, host } = hostOfUrl(u, name);
      if (name === '--tunnel-url' && !['ws:', 'wss:'].includes(url.protocol)) errs.push('--tunnel-url must be ws:// or wss://');
      if (name === '--api-url' && !['http:', 'https:'].includes(url.protocol)) errs.push('--api-url must be http:// or https://');
      endpoints.push([name, host]);
    } catch (e) {
      errs.push(e.message);
    }
  }
  if (!cfg.allowRemote) {
    for (const [name, host] of endpoints) {
      if (!isLocalHost(host)) errs.push(`${name} ${host} is not a local address; pass --allow-remote to load a remote gateway`);
    }
  }
  if (cfg.gatewayPid && cfg.allowRemote && !isLocalHost(cfg.gateway)) {
    errs.push('--gateway-pid samples /proc on this host; it cannot be used with a remote --gateway');
  }
  return errs;
}

/** Which protocols the run drives. */
export function protocolsFor(cfg) {
  return cfg.protocol === 'both' ? [...PROTOCOLS] : [cfg.protocol];
}

/** Nearest-rank percentile over a sorted array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/** Summary of a list of latency samples (ms). */
export function latencySummary(values) {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return { count: 0, min: null, mean: null, p50: null, p95: null, p99: null, max: null };
  let sum = 0;
  for (const v of sorted) sum += v;
  const r = (x) => Math.round(x * 100) / 100;
  return {
    count: sorted.length,
    min: r(sorted[0]),
    mean: r(sum / sorted.length),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    max: r(sorted[sorted.length - 1]),
  };
}

/**
 * Bounded latency reservoir: keeps every sample up to `cap`, then reservoir
 * samples (Algorithm R) so soak runs use constant memory.
 */
export class Reservoir {
  constructor(cap = 200_000, random = Math.random) {
    this.cap = cap;
    this.random = random;
    this.values = [];
    this.seen = 0;
  }
  add(v) {
    this.seen++;
    if (this.values.length < this.cap) this.values.push(v);
    else {
      const j = Math.floor(this.random() * this.seen);
      if (j < this.cap) this.values[j] = v;
    }
  }
}

/** Map a client-side failure to a stable error class for the report. */
export function classifyError(err) {
  if (!err) return 'unknown';
  if (err.lgClass) return err.lgClass;
  const code = err.code;
  if (code === 'ECONNREFUSED') return 'conn_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'conn_reset';
  if (code === 'ETIMEDOUT' || code === 'LT_TIMEOUT') return 'timeout';
  if (code === 'EMFILE' || code === 'ENFILE') return 'local_fd_exhausted';
  if (code === 'EADDRNOTAVAIL' || code === 'EADDRINUSE') return 'local_ports_exhausted';
  if (code === 'LT_SHORT_READ') return 'short_response';
  return code ? `other_${String(code).toLowerCase()}` : 'other';
}

/** Error class for a non-2xx HTTP CONNECT reply (status + X-DominusNode-Error). */
export function httpConnectErrorClass(status, dnCode) {
  const s = Number(status);
  const code = typeof dnCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(dnCode) ? dnCode : '';
  return `http_${Number.isInteger(s) ? s : 'bad'}${code ? '_' + code : ''}`;
}

const SOCKS_REPLIES = {
  1: 'general_failure',
  2: 'not_allowed',
  3: 'network_unreachable',
  4: 'host_unreachable',
  5: 'conn_refused',
  6: 'ttl_expired',
  7: 'cmd_unsupported',
  8: 'atyp_unsupported',
};

export function socksErrorClass(rep) {
  return `socks5_${SOCKS_REPLIES[rep] ?? 'rep_' + rep}`;
}

/** Billed bytes vs bytes the clients pushed through established tunnels. */
export function meteringAccuracy(sentBytes, billedBytes) {
  if (billedBytes === null || billedBytes === undefined || !Number.isFinite(billedBytes)) {
    return { sentBytes, billedBytes: null, ratio: null, deltaBytes: null, deltaPct: null, verdict: 'not_measured' };
  }
  const delta = billedBytes - sentBytes;
  const ratio = sentBytes > 0 ? billedBytes / sentBytes : null;
  const pct = sentBytes > 0 ? (delta / sentBytes) * 100 : null;
  let verdict;
  if (sentBytes === 0) verdict = billedBytes === 0 ? 'ok' : 'over_billed';
  else if (Math.abs(pct) <= 1) verdict = 'ok';
  else verdict = delta > 0 ? 'over_billed' : 'under_billed';
  return {
    sentBytes,
    billedBytes,
    ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
    deltaBytes: delta,
    deltaPct: pct === null ? null : Math.round(pct * 100) / 100,
    verdict,
  };
}

/** Min / max / last / growth of a numeric series sampled over the run. */
export function seriesSummary(points) {
  const vals = points.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return { first: vals[0], last: vals[vals.length - 1], min: Math.min(...vals), max: Math.max(...vals), growth: vals[vals.length - 1] - vals[0] };
}

/**
 * Build the machine-readable report.
 * `proto` maps protocol -> { ok, errors: {cls: n}, connect: number[], total: number[], bytesUp, bytesDown }.
 */
export function buildReport({ cfg, startedAt, endedAt, proto, samples, billedBytes, notes = [] }) {
  const secs = Math.max((endedAt - startedAt) / 1000, 0.001);
  const protocols = {};
  let tunnelBytes = 0;
  let ok = 0;
  let failed = 0;
  for (const [name, p] of Object.entries(proto)) {
    const errCount = Object.values(p.errors).reduce((a, b) => a + b, 0);
    const bytes = p.bytesUp + p.bytesDown;
    tunnelBytes += bytes;
    ok += p.ok;
    failed += errCount;
    protocols[name] = {
      requests: p.ok + errCount,
      ok: p.ok,
      failed: errCount,
      errorRatePct: p.ok + errCount ? Math.round((errCount / (p.ok + errCount)) * 10000) / 100 : 0,
      rps: Math.round((p.ok / secs) * 100) / 100,
      throughputMbps: Math.round(((bytes * 8) / secs / 1e6) * 1000) / 1000,
      bytesUp: p.bytesUp,
      bytesDown: p.bytesDown,
      connectMs: latencySummary(p.connect),
      totalMs: latencySummary(p.total),
      errors: { ...p.errors },
    };
  }
  const rss = seriesSummary(samples.map((s) => s.rssBytes));
  const fds = seriesSummary(samples.map((s) => s.fds));
  const { target, username } = cfg;
  return {
    tool: 'dominusnode-gateway-loadtest',
    version: 1,
    mode: cfg.soak ? 'soak' : 'load',
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.round(secs * 100) / 100,
    config: {
      gateway: cfg.gateway,
      httpPort: cfg.httpPort,
      socksPort: cfg.socksPort,
      protocols: protocolsFor(cfg),
      concurrency: cfg.concurrency,
      rate: cfg.rate,
      requestBytes: cfg.requestBytes,
      responseBytes: cfg.responseBytes,
      target,
      username,
      mockGateway: cfg.mockGateway,
      mockNodes: cfg.mockNodes,
    },
    totals: {
      requests: ok + failed,
      ok,
      failed,
      errorRatePct: ok + failed ? Math.round((failed / (ok + failed)) * 10000) / 100 : 0,
      rps: Math.round((ok / secs) * 100) / 100,
      throughputMbps: Math.round(((tunnelBytes * 8) / secs / 1e6) * 1000) / 1000,
      tunnelBytes,
    },
    protocols,
    gateway: {
      pid: cfg.gatewayPid || null,
      samples: samples.length,
      rssBytes: rss,
      fds,
    },
    metering: meteringAccuracy(tunnelBytes, billedBytes),
    notes,
  };
}

const fmt = (v, unit = '') => (v === null || v === undefined ? '-' : `${v}${unit}`);
const mib = (b) => (Number.isFinite(b) ? `${(b / 1048576).toFixed(1)} MiB` : '-');

/** Human-readable rendering of buildReport() output. */
export function renderText(r) {
  const out = [];
  out.push(`DominusNode gateway ${r.mode} test`);
  out.push(`  ${r.startedAt} -> ${r.endedAt} (${r.durationSec}s)`);
  out.push(`  gateway ${r.config.gateway} http:${r.config.httpPort} socks5:${r.config.socksPort}` + (r.config.mockGateway ? ' [mock gateway]' : '') + (r.config.mockNodes ? ' [mock nodes]' : ''));
  out.push(`  concurrency ${r.config.concurrency}, rate ${r.config.rate || 'unlimited'}/s, payload ${r.config.requestBytes}B up / ${r.config.responseBytes}B down, target ${r.config.target}`);
  out.push('');
  out.push(`Totals: ${r.totals.requests} requests, ${r.totals.ok} ok, ${r.totals.failed} failed (${r.totals.errorRatePct}%), ${r.totals.rps} req/s, ${r.totals.throughputMbps} Mbit/s`);
  for (const [name, p] of Object.entries(r.protocols)) {
    out.push('');
    out.push(`[${name}] ${p.requests} requests, ${p.ok} ok, ${p.failed} failed (${p.errorRatePct}%), ${p.rps} req/s, ${p.throughputMbps} Mbit/s`);
    for (const [label, l] of [['connect', p.connectMs], ['total  ', p.totalMs]]) {
      out.push(`  ${label} ms  p50 ${fmt(l.p50)}  p95 ${fmt(l.p95)}  p99 ${fmt(l.p99)}  max ${fmt(l.max)}  (n=${l.count})`);
    }
    const errs = Object.entries(p.errors).sort((a, b) => b[1] - a[1]);
    if (errs.length) out.push(`  errors: ${errs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  out.push('');
  const g = r.gateway;
  if (g.pid) {
    out.push(`Gateway pid ${g.pid}: ${g.samples} samples`);
    if (g.rssBytes) out.push(`  RSS  first ${mib(g.rssBytes.first)}  max ${mib(g.rssBytes.max)}  last ${mib(g.rssBytes.last)}  growth ${mib(g.rssBytes.growth)}`);
    if (g.fds) out.push(`  fds  first ${g.fds.first}  max ${g.fds.max}  last ${g.fds.last}  growth ${g.fds.growth}`);
  } else out.push('Gateway process: not sampled (pass --gateway-pid)');
  const m = r.metering;
  if (m.verdict === 'not_measured') out.push(`Metering: not measured (tunnel bytes ${m.sentBytes}; pass --api-url with DN_LOADTEST_API_KEY)`);
  else out.push(`Metering: billed ${m.billedBytes} B vs tunnel ${m.sentBytes} B, ratio ${fmt(m.ratio)}, delta ${fmt(m.deltaPct, '%')} -> ${m.verdict}`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  return out.join('\n') + '\n';
}

export const USAGE = `Usage: npm run loadtest -- [options]

Drives concurrent HTTP CONNECT and SOCKS5 clients through the relay gateway to a
local sink server and writes <out>.json and <out>.txt.

Target selection
  --gateway HOST            gateway host (default 127.0.0.1; must be local)
  --http-port N             HTTP proxy port (default 8080)
  --socks-port N            SOCKS5 port (default 1080)
  --protocol P              http | socks5 | both (default both)
  --target HOST:PORT        CONNECT target (default loadtest.example.org:443)
  --username FLAGS          proxy username flags (default relay)
  --allow-remote            allow non-local gateway/tunnel/API hosts

Load shape
  --concurrency N           concurrent clients per protocol (default 10)
  --rate R                  max new tunnels per second, all clients (0 = closed loop)
  --duration S              seconds (default 30; 3600 with --soak)
  --soak                    soak mode: periodic interim reports, bounded memory
  --report-interval S       soak interim report period (default 60)
  --request-bytes N         bytes sent per tunnel (default 1024)
  --response-bytes N        bytes the sink returns per tunnel (default 16384)
  --timeout S               per-tunnel timeout (default 30)

Topology
  --mock-gateway            in-process pass-through gateway (harness baseline)
  --mock-nodes              run mock node agents (key files from env) that
                            route every OPEN to the local sink
  --tunnel-url URL          gateway node tunnel (wss://...), with --mock-nodes

Measurements
  --gateway-pid PID         sample RSS and open fds of the gateway process
  --sample-interval S       sampling period (default 1)
  --api-url URL             API base URL for metering accuracy (/api/usage)
  --metering-wait S         wait for usage flush before reading (default 15)
  --out PREFIX              report path prefix (default loadtest-report)

Environment (secrets are never accepted as arguments)
  DN_LOADTEST_API_KEY            requester dn_live_ key (proxy password, /api/usage)
  DN_LOADTEST_NODE_KEY_FILES     comma-separated node key files (mode 0600), --mock-nodes
  DN_LOADTEST_COORD_PINS         coordinator ed25519 pubkeys (hex, comma-separated)
  DN_LOADTEST_TUNNEL_CA_FILE     optional PEM CA for a self-signed local tunnel
`;
