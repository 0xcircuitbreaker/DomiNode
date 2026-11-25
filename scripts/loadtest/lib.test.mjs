import { describe, expect, it } from 'vitest';
import {
  ArgError, DEFAULTS, Reservoir, buildReport, classifyError, httpConnectErrorClass, isLocalHost,
  latencySummary, meteringAccuracy, parseArgs, percentile, protocolsFor, renderText, seriesSummary,
  socksErrorClass, splitHostPort, validateConfig,
} from './lib.mjs';

describe('parseArgs', () => {
  it('returns defaults', () => {
    const c = parseArgs([]);
    expect(c.concurrency).toBe(DEFAULTS.concurrency);
    expect(c.duration).toBe(30);
  });
  it('parses space and = forms and booleans', () => {
    const c = parseArgs(['--concurrency', '50', '--rate=200', '--mock-gateway', '--protocol', 'socks5']);
    expect(c).toMatchObject({ concurrency: 50, rate: 200, mockGateway: true, protocol: 'socks5' });
  });
  it('soak defaults to one hour unless duration given', () => {
    expect(parseArgs(['--soak']).duration).toBe(3600);
    expect(parseArgs(['--soak', '--duration', '60']).duration).toBe(60);
  });
  it('rejects unknown flags, missing values, bad numbers', () => {
    expect(() => parseArgs(['--nope'])).toThrow(ArgError);
    expect(() => parseArgs(['--concurrency'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--concurrency', 'x'])).toThrow(/number/);
    expect(() => parseArgs(['--concurrency', '1.5'])).toThrow(/integer/);
    expect(() => parseArgs(['--soak=yes'])).toThrow(/no value/);
  });
  it('has no flag that accepts a key', () => {
    expect(() => parseArgs(['--api-key', 'dn_live_x'])).toThrow(/unknown option/);
  });
});

describe('isLocalHost / splitHostPort', () => {
  it.each(['127.0.0.1', 'localhost', 'gw.localhost', '::1', '[::1]', '10.1.2.3', '172.20.0.1', '192.168.1.1', 'fd00::1', '::ffff:127.0.0.1'])('%s is local', (h) => {
    expect(isLocalHost(h)).toBe(true);
  });
  it.each(['8.8.8.8', 'example.org', '172.32.0.1', '2001:db8::1', '', '::ffff:8.8.8.8'])('%s is not local', (h) => {
    expect(isLocalHost(h)).toBe(false);
  });
  it('splits host:port', () => {
    expect(splitHostPort('example.org:443')).toEqual({ host: 'example.org', port: 443 });
    expect(splitHostPort('[::1]:80')).toEqual({ host: '::1', port: 80 });
    expect(splitHostPort('example.org')).toBeNull();
    expect(splitHostPort('a:0')).toBeNull();
    expect(splitHostPort('a:70000')).toBeNull();
  });
});

describe('validateConfig', () => {
  const ok = () => parseArgs([]);
  it('accepts defaults', () => expect(validateConfig(ok())).toEqual([]));
  it('refuses remote endpoints without --allow-remote', () => {
    expect(validateConfig({ ...ok(), gateway: 'gw.example.org' }).join()).toMatch(/--allow-remote/);
    expect(validateConfig({ ...ok(), apiUrl: 'https://api.example.org' }).join()).toMatch(/--api-url.*--allow-remote/);
    expect(validateConfig({ ...ok(), mockNodes: true, tunnelUrl: 'wss://gw.example.org/tunnel' }).join()).toMatch(/--tunnel-url/);
    expect(validateConfig({ ...ok(), gateway: 'gw.example.org', allowRemote: true })).toEqual([]);
  });
  it('rejects gateway-pid with a remote gateway', () => {
    expect(validateConfig({ ...ok(), gateway: 'gw.example.org', allowRemote: true, gatewayPid: 12 }).join()).toMatch(/proc/);
  });
  it('checks ranges and combinations', () => {
    const e = validateConfig({ ...ok(), concurrency: 0, protocol: 'ftp', httpPort: 70000, requestBytes: -1, target: 'nope', username: 'a b', mockGateway: true, mockNodes: true }).join('\n');
    for (const s of ['--concurrency', '--protocol', '--http-port', '--request-bytes', '--target', '--username', 'cannot be combined', '--tunnel-url']) expect(e).toContain(s);
  });
  it('rejects bad URL schemes', () => {
    expect(validateConfig({ ...ok(), apiUrl: 'ftp://127.0.0.1' }).join()).toMatch(/http/);
    expect(validateConfig({ ...ok(), apiUrl: 'not a url' }).join()).toMatch(/valid URL/);
  });
  it('protocolsFor', () => {
    expect(protocolsFor({ protocol: 'both' })).toEqual(['http', 'socks5']);
    expect(protocolsFor({ protocol: 'http' })).toEqual(['http']);
  });
});

describe('stats', () => {
  it('percentile nearest rank', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile(s, 100)).toBe(100);
    expect(percentile(s, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
  });
  it('latencySummary sorts numerically', () => {
    const l = latencySummary([10, 2, 30, 4]);
    expect(l).toMatchObject({ count: 4, min: 2, max: 30, p50: 4, mean: 11.5 });
    expect(latencySummary([]).p99).toBeNull();
  });
  it('reservoir caps memory and counts all samples', () => {
    const r = new Reservoir(10, () => 0);
    for (let i = 0; i < 100; i++) r.add(i);
    expect(r.values).toHaveLength(10);
    expect(r.seen).toBe(100);
  });
  it('seriesSummary', () => {
    expect(seriesSummary([5, null, 9, 7])).toEqual({ first: 5, last: 7, min: 5, max: 9, growth: 2 });
    expect(seriesSummary([null])).toBeNull();
  });
});

describe('error classes', () => {
  it('classifies socket errors', () => {
    expect(classifyError({ code: 'ECONNREFUSED' })).toBe('conn_refused');
    expect(classifyError({ code: 'EPIPE' })).toBe('conn_reset');
    expect(classifyError({ code: 'EMFILE' })).toBe('local_fd_exhausted');
    expect(classifyError({ code: 'EADDRNOTAVAIL' })).toBe('local_ports_exhausted');
    expect(classifyError({ code: 'EHOSTUNREACH' })).toBe('other_ehostunreach');
    expect(classifyError({ lgClass: 'short_response', code: 'X' })).toBe('short_response');
    expect(classifyError(null)).toBe('unknown');
  });
  it('http and socks classes', () => {
    expect(httpConnectErrorClass(429, 'TOO_MANY_CONNECTIONS')).toBe('http_429_TOO_MANY_CONNECTIONS');
    expect(httpConnectErrorClass('502', 'bad code!')).toBe('http_502');
    expect(socksErrorClass(5)).toBe('socks5_conn_refused');
    expect(socksErrorClass(42)).toBe('socks5_rep_42');
  });
});

describe('metering', () => {
  it('verdicts', () => {
    expect(meteringAccuracy(1000, null).verdict).toBe('not_measured');
    expect(meteringAccuracy(1000, 1005)).toMatchObject({ verdict: 'ok', deltaBytes: 5, deltaPct: 0.5, ratio: 1.005 });
    expect(meteringAccuracy(1000, 1100).verdict).toBe('over_billed');
    expect(meteringAccuracy(1000, 900).verdict).toBe('under_billed');
    expect(meteringAccuracy(0, 0).verdict).toBe('ok');
    expect(meteringAccuracy(0, 10).verdict).toBe('over_billed');
  });
});

describe('report', () => {
  const cfg = parseArgs(['--gateway-pid', '42']);
  const report = buildReport({
    cfg, startedAt: 0, endedAt: 10_000, billedBytes: 3000, notes: ['n1'],
    samples: [{ rssBytes: 1048576, fds: 10 }, { rssBytes: 2097152, fds: 12 }],
    proto: {
      http: { ok: 9, errors: { timeout_transfer: 1 }, connect: [1, 2, 3], total: [5, 6, 7], bytesUp: 1000, bytesDown: 2000 },
      socks5: { ok: 0, errors: {}, connect: [], total: [], bytesUp: 0, bytesDown: 0 },
    },
  });
  it('aggregates totals and rates', () => {
    expect(report.totals).toMatchObject({ requests: 10, ok: 9, failed: 1, errorRatePct: 10, rps: 0.9, tunnelBytes: 3000 });
    expect(report.protocols.http.connectMs.p50).toBe(2);
    expect(report.protocols.http.throughputMbps).toBe(0.002);
    expect(report.gateway.rssBytes.growth).toBe(1048576);
    expect(report.gateway.fds.max).toBe(12);
    expect(report.metering.verdict).toBe('ok');
    expect(report.mode).toBe('load');
  });
  it('never embeds secrets in config', () => {
    expect(JSON.stringify(report)).not.toMatch(/dn_live_/);
  });
  it('renders text', () => {
    const t = renderText(report);
    expect(t).toContain('[http] 10 requests');
    expect(t).toContain('timeout_transfer=1');
    expect(t).toContain('Gateway pid 42');
    expect(t).toContain('-> ok');
    expect(t).toContain('Note: n1');
    const t2 = renderText(buildReport({ cfg: parseArgs([]), startedAt: 0, endedAt: 1, billedBytes: null, samples: [], proto: {} }));
    expect(t2).toContain('not sampled');
    expect(t2).toContain('Metering: not measured');
  });
});
