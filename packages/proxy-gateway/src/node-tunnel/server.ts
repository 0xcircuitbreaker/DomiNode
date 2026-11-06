/**
 * Node tunnel server (DESIGN.md §2.1, §2.4, §2.5): WS upgrade on TUNNEL_PORT,
 * Bearer dn_node_ auth, HELLO -> CHALLENGE -> AUTH_OK handshake with a 10 s
 * deadline and 4 KiB pre-auth cap, peer-geo sanctions, per-/32,/24,ASN caps,
 * heartbeat and POLICY_UPDATE push. Streams are carried by TunnelMux.
 */
import * as http from "node:http";
import * as netMod from "node:net";
import * as tls from "node:tls";
import { randomBytes } from "node:crypto";
import { type Socket, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  FrameType,
  FrameDecoder,
  encodeFrame,
  encodeControl,
  decodeControl,
  TunnelProtocolError,
  MAX_FRAME_PAYLOAD,
  hashNodeKey,
  isBlockedCountry,
  isPublicAddress,
  type Frame,
  type ActivePolicy,
  type TunnelAuthNode,
  type NodeIpClass,
  type ChannelBinding,
  challengeMessage,
  authMessage,
  verifyEd25519,
  EXPORTER_LABEL,
  EXPORTER_LENGTH,
} from "@dominusnode/shared";
import { TunnelMux, STREAM_WINDOW, type StreamCloseReport } from "./mux.js";
import { PreAuthLimiter, normalizePeerIp, readProxyV2, type PreAuthLimiterOptions } from "./ingress.js";
import { NodeRegistry, ipPrefix, dayOf, type LiveNode, type NodeTunnelHandle } from "./registry.js";

export const DEFAULT_TUNNEL_PORT = 8443;
export const HANDSHAKE_DEADLINE_MS = 10_000;
export const PRE_AUTH_MAX_BYTES = 4096;
export const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_MISSED_PONGS = 3;
const NODE_KEY_RE = /^dn_node_[0-9a-f]{64}$/;
const TUNNEL_PATH = "/v1/tunnel";

/** TUNNEL_PORT with NaN and range validation; throws on invalid input. */
export function resolveTunnelPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TUNNEL_PORT;
  if (!/^\d+$/.test(raw.trim())) throw new Error("TUNNEL_PORT must be an integer");
  const n = parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) throw new Error("TUNNEL_PORT must be in 1..65535");
  return n;
}

export interface GeoInfo {
  country: string | null;
  asn: number | null;
  ipClass?: NodeIpClass | null;
}

export interface TunnelLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface TunnelServerDeps {
  getNodeForTunnelAuth: (keyHash: string) => Promise<TunnelAuthNode | null>;
  markOnline: (nodeId: string, ip: string, country: string | null, asn: number | null, ipClass?: NodeIpClass | null) => Promise<boolean>;
  markOffline: (nodeId: string) => Promise<boolean>;
  /**
   * Fleet-wide /32, /24 and ASN caps (shared store). Called after the local
   * registry check; false rejects with IP_CAP. Errors fail closed.
   */
  claimIpSlot?: (s: { nodeId: string; ip: string; prefix24: string; asn: number | null; enforceAsn: boolean; limits: { per32: number; per24: number; perAsn: number } }) => Promise<boolean>;
  releaseIpSlot?: (nodeId: string) => Promise<void>;
  /**
   * Promote a `pending` node to `active` (compare-and-set from 'pending' only).
   * Called once a tunnel whose attestation meets the current policy minVersion
   * has passed every handshake check. Returns false if the row was not pending.
   */
  activatePending?: (nodeId: string) => Promise<boolean>;
  /** Current policy snapshot (loaded by the caller every 30 s). */
  getPolicy: () => ActivePolicy;
  /** Peer IP geo; null = lookup unavailable (fail closed for public IPs). */
  geoLookup: (ip: string) => GeoInfo | null;
  /**
   * ed25519 coordinator signature (hex) over challengeMessage(). Required in
   * production (main.ts refuses to start without COORD_SIGNING_KEY_FILE); nodes
   * reject an unsigned or mis-signed CHALLENGE.
   */
  coordSign?: (msg: Buffer) => string;
  /** Known floorHash values; unknown ones lower selection weight. */
  knownFloorHashes?: ReadonlySet<string>;
  /** Byte reports for disputes (CLOSE frames vs gateway counts). */
  onStreamClose?: (nodeId: string, r: StreamCloseReport) => void;
}

export interface TunnelServerOptions {
  port?: number;
  host?: string;
  heartbeatMs?: number;
  handshakeDeadlineMs?: number;
  initialWindow?: number;
  logger?: TunnelLogger;
  /**
   * TCP peers allowed to prepend a PROXY protocol v2 header (e.g. Caddy layer4).
   * From these the header is mandatory; from anyone else the raw socket address is used.
   */
  trustedProxyIps?: ReadonlySet<string>;
  /** Terminate TLS in the gateway itself (enables tls-exporter channel binding). */
  tls?: { cert: Buffer; key: Buffer } | null;
  /** Production: peers resolving to non-public IPs are refused (misconfigured proxy front). */
  production?: boolean;
  /** Refuse public peers whose ASN is unknown (production without ASN_DB_OPTIONAL). */
  requireAsn?: boolean;
  preAuth?: PreAuthLimiterOptions;
}

const silent: TunnelLogger = { info: () => undefined, warn: () => undefined };

function rejectUpgrade(socket: Socket | Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

interface HelloCaps {
  maxStreams: number;
  ports: number[];
  floorHash: string | null;
  agentVersion: string | null;
}

/** One authenticated (or authenticating) node connection. */
export class NodeTunnel implements NodeTunnelHandle {
  readonly mux: TunnelMux;
  private decoder = new FrameDecoder();
  private state: "hello" | "challenged" | "authorizing" | "ready" | "closed" = "hello";
  private nonce = "";
  private caps: HelloCaps | null = null;
  private preAuthBytes = 0;
  private deadline: NodeJS.Timeout | null;
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private pingSeq = 0;
  private pingSent = new Map<number, number>();
  rttMs: number | null = null;
  live: LiveNode | null = null;

  constructor(
    private readonly ws: WebSocket,
    readonly node: TunnelAuthNode,
    readonly peerIp: string,
    private readonly server: NodeTunnelServer,
    /** TLS exporter of this connection; null when TLS terminates upstream (binding "none"). */
    private readonly exporter: Buffer | null = null,
  ) {
    this.mux = new TunnelMux({
      send: (b) => this.send(b),
      maxStreams: Math.max(1, node.max_streams),
      initialWindow: server.initialWindow,
      onStreamClose: (r) => server.reportStreamClose(node.id, r),
    });
    this.deadline = setTimeout(() => this.close("handshake timeout", 1008), server.handshakeDeadlineMs);
    this.deadline.unref?.();
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => this.onMessage(data, isBinary));
    ws.on("close", () => this.onClosed());
    ws.on("error", () => undefined);
  }

  get isOpen(): boolean {
    return this.state !== "closed";
  }

  get openStreams(): number {
    return this.mux.openStreams;
  }

  openStream(host: string, port: number): Promise<Duplex> {
    if (this.state !== "ready") return Promise.reject(new Error("tunnel not ready"));
    return this.mux.openStream(host, port);
  }

  private send(buf: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }

  sendControl(type: FrameType, obj: Record<string, unknown>): void {
    this.send(encodeFrame(type, 0, 0, encodeControl(obj)));
  }

  close(reason = "closed", code = 1000): void {
    if (this.state === "closed") return;
    try {
      this.ws.close(code, reason.slice(0, 100));
    } catch {
      this.ws.terminate();
    }
    const ws = this.ws;
    setTimeout(() => ws.terminate(), 2000).unref();
    this.onClosed();
  }

  private authFail(code: string): void {
    this.server.log.warn("tunnel auth rejected", { nodeId: this.node.id, code });
    this.sendControl(FrameType.AUTH_FAIL, { code });
    this.close("auth failed", 1008);
  }

  private onMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.state === "closed") return;
    if (!isBinary) return this.close("text message", 1003);
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (this.state !== "ready") {
      this.preAuthBytes += buf.length;
      if (this.preAuthBytes > PRE_AUTH_MAX_BYTES) return this.close("pre-auth cap", 1009);
    }
    let frames: Frame[];
    try {
      frames = this.decoder.push(buf);
    } catch {
      return this.close("protocol error", 1002);
    }
    for (const f of frames) {
      if (!this.isOpen) return;
      try {
        this.onFrame(f);
      } catch (e) {
        return this.close(e instanceof TunnelProtocolError ? "protocol error" : "frame error", 1002);
      }
    }
  }

  private onFrame(f: Frame): void {
    if (this.state === "hello") {
      if (f.type !== FrameType.HELLO || f.streamId !== 0) throw new TunnelProtocolError("expected HELLO");
      this.state = "challenged";
      const caps = this.parseHello(decodeControl(f.payload));
      if (!caps) return this.authFail("BAD_HELLO");
      if (!this.node.node_pubkey) return this.authFail("NO_PUBKEY");
      this.caps = caps;
      this.sendChallenge();
      return;
    }
    if (this.state === "challenged") {
      if (f.type !== FrameType.AUTH || f.streamId !== 0) throw new TunnelProtocolError("expected AUTH");
      const a = decodeControl<{ sig?: unknown }>(f.payload);
      let ok = false;
      try {
        ok = verifyEd25519(this.node.node_pubkey ?? "", authMessage(this.nonce, this.node.id, this.exporter), a.sig);
      } catch {
        ok = false;
      }
      this.nonce = ""; // single use
      if (!ok) return this.authFail("BAD_SIGNATURE");
      this.state = "authorizing";
      const caps = this.caps as HelloCaps;
      this.server.authorize(this, caps).catch((e: unknown) => {
        this.server.log.warn("tunnel authorize error", { nodeId: this.node.id, error: e instanceof Error ? e.message.slice(0, 200) : "error" });
        if (this.state === "authorizing") this.authFail("INTERNAL");
      });
      return;
    }
    if (this.state === "authorizing") throw new TunnelProtocolError("unexpected pre-auth frame");
    if (f.streamId === 0) {
      switch (f.type) {
        case FrameType.PING:
          return this.send(encodeFrame(FrameType.PONG, 0, 0, encodeControl(decodeControl(f.payload))));
        case FrameType.PONG: {
          this.missedPongs = 0;
          const p = decodeControl<{ seq?: unknown }>(f.payload);
          const sent = typeof p.seq === "number" ? this.pingSent.get(p.seq) : undefined;
          if (sent !== undefined) {
            this.pingSent.delete(p.seq as number);
            const rtt = Date.now() - sent;
            this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.8 + rtt * 0.2;
            if (this.live) {
              const sample = rtt < 200 ? 1 : rtt < 1000 ? 0.8 : 0.5;
              this.live.health = this.live.health * 0.9 + sample * 0.1;
            }
          }
          return;
        }
        default:
          throw new TunnelProtocolError("unexpected control frame");
      }
    }
    this.mux.handleFrame(f);
  }

  private parseHello(h: Record<string, unknown>): HelloCaps | null {
    if (typeof h.nodeId === "string" && h.nodeId !== this.node.id) return null;
    const c = (h.caps && typeof h.caps === "object" ? h.caps : {}) as Record<string, unknown>;
    const maxStreams = typeof c.maxStreams === "number" && Number.isInteger(c.maxStreams) && c.maxStreams > 0
      ? Math.min(c.maxStreams, 4096) : this.node.max_streams;
    const ports = Array.isArray(c.ports)
      ? c.ports.filter((p): p is number => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535).slice(0, 64)
      : [80, 443];
    return {
      maxStreams,
      ports,
      floorHash: typeof h.floorHash === "string" ? h.floorHash.slice(0, 128) : null,
      agentVersion: typeof h.agentVersion === "string" ? h.agentVersion.slice(0, 64) : null,
    };
  }

  private sendChallenge(): void {
    const policy = this.server.deps.getPolicy();
    const nonce = randomBytes(32).toString("hex");
    const serverTime = Date.now();
    const binding: ChannelBinding = this.exporter ? "tls-exporter" : "none";
    this.nonce = nonce;
    const msg = challengeMessage(nonce, policy.version, serverTime, binding);
    const coordSig = this.server.deps.coordSign ? this.server.deps.coordSign(msg) : "";
    this.sendControl(FrameType.CHALLENGE, { nonce, policyVersion: policy.version, serverTime, binding, coordSig });
  }

  /** Called by the server once all checks pass. */
  markReady(live: LiveNode): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.live = live;
    this.state = "ready";
    const policy = this.server.deps.getPolicy();
    this.sendControl(FrameType.AUTH_OK, {
      heartbeatMs: this.server.heartbeatMs, initialWindow: this.mux.initialWindow, policyHash: policy.sha256,
    });
    this.pushPolicy(policy);
    this.startHeartbeat();
  }

  isAuthorizing(): boolean {
    return this.state === "authorizing";
  }

  rejectAuth(code: string): void {
    this.authFail(code);
  }

  pushPolicy(policy: ActivePolicy): void {
    if (this.state !== "ready") return;
    this.sendControl(FrameType.POLICY_UPDATE, {
      policyVersion: policy.version, ports: policy.body.ports, categoriesVersion: policy.body.categoriesVersion,
    });
  }

  drain(): void {
    if (this.state === "ready") this.sendControl(FrameType.DRAIN, {});
  }

  private startHeartbeat(): void {
    const tick = (): void => {
      if (this.state !== "ready") return;
      if (this.missedPongs >= MAX_MISSED_PONGS) return this.close("heartbeat timeout", 1001);
      this.missedPongs++;
      const seq = ++this.pingSeq;
      const ts = Date.now();
      this.pingSent.set(seq, ts);
      if (this.pingSent.size > MAX_MISSED_PONGS + 1) {
        const oldest = this.pingSent.keys().next().value;
        if (oldest !== undefined) this.pingSent.delete(oldest);
      }
      this.sendControl(FrameType.PING, { seq, ts });
      this.pingTimer = setTimeout(tick, this.server.heartbeatMs);
      this.pingTimer.unref?.();
    };
    this.pingTimer = setTimeout(tick, this.server.heartbeatMs);
    this.pingTimer.unref?.();
  }

  private onClosed(): void {
    if (this.state === "closed") return;
    const wasReady = this.state === "ready";
    this.state = "closed";
    if (this.deadline) clearTimeout(this.deadline);
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.deadline = this.pingTimer = null;
    this.mux.closeAll("tunnel_closed");
    this.server.onTunnelClosed(this, wasReady);
  }
}

/**
 * RFC 5705 exporter for a directly-terminated TLS socket. Behind a
 * TLS-terminating proxy (the default deployment: Caddy/nginx -> plain WS) there
 * is no TLSSocket here, binding falls back to the signed single-use nonce, and
 * the CHALLENGE announces binding "none".
 */
export function tlsExporter(sock: unknown): Buffer | null {
  const s = sock as { encrypted?: boolean; exportKeyingMaterial?: (len: number, label: string) => Buffer };
  if (!s || s.encrypted !== true || typeof s.exportKeyingMaterial !== "function") return null;
  try {
    const b = s.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL);
    return Buffer.isBuffer(b) && b.length === EXPORTER_LENGTH ? b : null;
  } catch {
    return null;
  }
}

export class NodeTunnelServer {
  readonly http: http.Server;
  private readonly wss: WebSocketServer;
  readonly log: TunnelLogger;
  readonly heartbeatMs: number;
  readonly handshakeDeadlineMs: number;
  readonly initialWindow: number;
  private tunnels = new Set<NodeTunnel>();
  /** Front TCP listener: resolves the real peer (PROXY v2 from trusted IPs only), optional TLS. */
  private readonly front: netMod.Server;
  private readonly peerOf = new WeakMap<object, string>();
  private readonly trusted: ReadonlySet<string>;
  private readonly secureContext: tls.SecureContext | null;
  readonly preAuth: PreAuthLimiter;

  constructor(readonly registry: NodeRegistry, readonly deps: TunnelServerDeps, private readonly opts: TunnelServerOptions = {}) {
    this.log = opts.logger ?? silent;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.handshakeDeadlineMs = opts.handshakeDeadlineMs ?? HANDSHAKE_DEADLINE_MS;
    this.initialWindow = Math.min(STREAM_WINDOW, Math.max(MAX_FRAME_PAYLOAD, opts.initialWindow ?? STREAM_WINDOW));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_PAYLOAD + 12, perMessageDeflate: false });
    this.http = http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("Upgrade Required");
    });
    this.trusted = opts.trustedProxyIps ?? new Set();
    this.secureContext = opts.tls ? tls.createSecureContext({ cert: opts.tls.cert, key: opts.tls.key, minVersion: "TLSv1.3" }) : null;
    this.preAuth = new PreAuthLimiter(opts.preAuth);
    if (opts.production && this.trusted.size === 0 && !this.secureContext) {
      this.log.warn("TUNNEL: production without TUNNEL_TRUSTED_PROXY_IPS or TUNNEL_TLS_*: peer IP is the raw TCP source; " +
        "if a proxy fronts this port every node will appear to come from it and non-public peers are REJECTED");
    }
    this.front = netMod.createServer((sock) => void this.onConnection(sock));
    this.http.on("upgrade", (req, socket, head) => {
      socket.on("error", () => undefined);
      this.onUpgrade(req, socket, head).catch(() => {
        if (!socket.destroyed) rejectUpgrade(socket, 500, "Internal Server Error");
      });
    });
  }

  get tunnelCount(): number {
    return this.tunnels.size;
  }

  async listen(): Promise<number> {
    const port = this.opts.port ?? DEFAULT_TUNNEL_PORT;
    await new Promise<void>((resolve, reject) => {
      this.front.once("error", reject);
      this.front.listen(port, this.opts.host ?? "0.0.0.0", () => {
        this.front.off("error", reject);
        resolve();
      });
    });
    this.preAuth.start();
    return (this.front.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const t of [...this.tunnels]) t.close("server shutdown", 1001);
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.preAuth.stop();
    this.http.closeAllConnections?.();
    await new Promise<void>((r) => this.front.close(() => r()));
  }

  private async onConnection(sock: Socket): Promise<void> {
    sock.on("error", () => undefined);
    const raw = normalizePeerIp(sock.remoteAddress);
    let peer = raw;
    if (raw && this.trusted.has(raw)) {
      try {
        peer = await readProxyV2(sock);
      } catch {
        sock.destroy();
        return;
      }
    }
    if (!peer || sock.destroyed) {
      sock.destroy();
      return;
    }
    let conn: Socket = sock;
    if (this.secureContext) {
      const t = new tls.TLSSocket(sock, { isServer: true, secureContext: this.secureContext });
      t.on("error", () => t.destroy());
      conn = t;
    }
    this.peerOf.set(conn, peer);
    this.http.emit("connection", conn);
    sock.resume();
  }

  /** Peer IP resolved at accept time; never from headers (X-Forwarded-For is ignored). */
  peerIpFor(sock: unknown): string {
    if (!sock || typeof sock !== "object") return "";
    return this.peerOf.get(sock) ?? "";
  }

  private async onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path !== TUNNEL_PATH) return rejectUpgrade(socket, 404, "Not Found");
    const auth = req.headers.authorization;
    const m = typeof auth === "string" ? /^Bearer (\S+)$/.exec(auth) : null;
    if (!m || !NODE_KEY_RE.test(m[1])) return rejectUpgrade(socket, 401, "Unauthorized");
    const peerIp = this.peerIpFor(req.socket);
    if (!peerIp) return rejectUpgrade(socket, 400, "Bad Request");
    if (this.opts.production && !isPublicAddress(peerIp)) {
      this.log.warn("tunnel upgrade from non-public peer refused in production (check TUNNEL_TRUSTED_PROXY_IPS)");
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    // Pre-auth DoS guard before any DB work: per-IP bucket, negative cache, global in-flight cap.
    if (!this.preAuth.allowIp(peerIp)) return rejectUpgrade(socket, 429, "Too Many Requests");
    const keyHash = hashNodeKey(m[1]);
    if (this.preAuth.isNegative(keyHash)) return rejectUpgrade(socket, 401, "Unauthorized");
    if (!this.preAuth.tryAcquire()) return rejectUpgrade(socket, 503, "Service Unavailable");
    let node: TunnelAuthNode | null;
    try {
      node = await this.deps.getNodeForTunnelAuth(keyHash);
    } finally {
      this.preAuth.release();
    }
    if (socket.destroyed) return;
    if (!node || (node.status !== "pending" && node.status !== "active")) {
      this.preAuth.addNegative(keyHash);
      return rejectUpgrade(socket, 401, "Unauthorized");
    }
    const policy = this.deps.getPolicy();
    if (node.attestation_version < policy.body.attestation.minVersion) return rejectUpgrade(socket, 403, "Forbidden");
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = "nodebuffer";
      const t = new NodeTunnel(ws, node, peerIp, this, tlsExporter(req.socket));
      this.tunnels.add(t);
    });
  }

  /** Coordinator-side checks before AUTH_OK (§2.4 step 3). */
  async authorize(t: NodeTunnel, caps: HelloCaps): Promise<void> {
    const policy = this.deps.getPolicy();
    const geo = this.deps.geoLookup(t.peerIp);
    const isPublic = isPublicAddress(t.peerIp);
    if (isPublic && geo === null) return t.rejectAuth("GEO_UNAVAILABLE");
    const country = geo?.country ? geo.country.toUpperCase() : null;
    if (country && (isBlockedCountry(country) || policy.body.sanctionedCountries.includes(country))) {
      return t.rejectAuth("SANCTIONED");
    }
    const asn = geo?.asn ?? null;
    if (isPublic && asn === null && this.opts.requireAsn) return t.rejectAuth("ASN_UNAVAILABLE");
    const prefix = ipPrefix(t.peerIp);
    const counts = this.registry.countPeers(t.peerIp, prefix, asn, t.node.id);
    const lim = policy.body.nodeCapsPerPrefix;
    // Per-ASN cap always holds for public peers: without ASN data every such
    // peer shares one "unknown ASN" bucket (conservative, fail-closed cap).
    const enforceAsn = asn !== null || isPublic;
    if (counts.per32 >= lim.per32 || counts.per24 >= lim.per24 || (enforceAsn && counts.perAsn >= lim.perAsn)) {
      return t.rejectAuth("IP_CAP");
    }
    const now = Date.now();
    const live: LiveNode = {
      nodeId: t.node.id, tunnel: t, ready: false, status: t.node.status, ip: t.peerIp, prefix24: prefix, asn, country,
      // Unverified class is never assumed residential: "unknown" nodes are left out of
      // explicit class-* selection and price at the "any" rate until classified.
      ipClass: geo?.ipClass ?? "unknown", ownerUserId: t.node.owner_user_id, ownerWallet: t.node.owner_wallet,
      ownerTeamId: t.node.owner_team_id, health: 1, reputation: t.node.reputation, reportPenalty: t.node.report_penalty ?? 0,
      maxStreams: Math.min(t.node.max_streams, caps.maxStreams), maxGbDay: t.node.max_gb_day, maxReqPerSec: t.node.max_req_per_sec ?? null,
      ports: caps.ports, bytesToday: 0, earningsTodayMusd: 0, day: dayOf(now), recentOpens: [], cooldownUntil: 0,
      cooldowns: new Map(), floorHashKnown: caps.floorHash !== null && (this.deps.knownFloorHashes?.has(caps.floorHash) ?? false),
      connectedAt: now,
    };
    // Reserve the slot synchronously so concurrent handshakes see it in countPeers().
    let prev: LiveNode | null;
    try {
      prev = this.registry.add(live);
    } catch {
      return t.rejectAuth("REGISTRY_FULL");
    }
    if (prev && prev.tunnel !== t) prev.tunnel.close("replaced");
    if (this.deps.claimIpSlot) {
      let claimed = false;
      try {
        claimed = await this.deps.claimIpSlot({ nodeId: t.node.id, ip: t.peerIp, prefix24: prefix, asn, enforceAsn, limits: lim });
      } catch {
        claimed = false;
      }
      if (!t.isAuthorizing() || !claimed) {
        this.registry.remove(t.node.id, t);
        // The tunnel may have closed (and released) while the claim was in
        // flight; release again unless another tunnel now owns this node.
        if (claimed && !this.registry.get(t.node.id)) this.releaseSlot(t.node.id);
        if (t.isAuthorizing()) return t.rejectAuth("IP_CAP");
        return;
      }
    }
    let ok = false;
    try {
      ok = await this.deps.markOnline(t.node.id, t.peerIp, country, asn, geo?.ipClass ?? null);
    } catch {
      ok = false;
    }
    if (!t.isAuthorizing()) {
      if (this.registry.remove(t.node.id, t)) this.releaseSlot(t.node.id);
      return;
    }
    if (!ok) {
      if (this.registry.remove(t.node.id, t)) this.releaseSlot(t.node.id);
      return t.rejectAuth("NODE_UNAVAILABLE");
    }
    // A freshly registered (or re-attested) node starts as `pending`; the upgrade
    // already required attestation_version >= policy minVersion, so a completed
    // handshake is what makes it selectable. Failure leaves it pending (fail closed).
    if (live.status === "pending" && this.deps.activatePending) {
      try {
        if (await this.deps.activatePending(t.node.id)) live.status = "active";
      } catch {
        /* stays pending: not selectable */
      }
      if (!t.isAuthorizing()) {
        if (this.registry.remove(t.node.id, t)) this.releaseSlot(t.node.id);
        return;
      }
    }
    t.mux.maxStreams = Math.max(1, Math.min(live.maxStreams, policy.body.nodeDefaults.maxStreams));
    live.ready = true;
    t.markReady(live);
    this.log.info("node tunnel ready", { nodeId: t.node.id, country, agentVersion: caps.agentVersion });
  }

  private releaseSlot(nodeId: string): void {
    this.deps.releaseIpSlot?.(nodeId).catch(() => undefined); // expires via heartbeat TTL if this fails
  }

  reportStreamClose(nodeId: string, r: StreamCloseReport): void {
    const live = this.registry.get(nodeId);
    if (live) {
      const today = dayOf(Date.now());
      if (live.day !== today) {
        live.day = today;
        live.bytesToday = 0;
        live.earningsTodayMusd = 0;
      }
      live.bytesToday += r.gatewayBytesIn + r.gatewayBytesOut;
    }
    if (r.nodeReport) {
      const nodeTotal = r.nodeReport.bytesIn + r.nodeReport.bytesOut;
      const gwTotal = r.gatewayBytesIn + r.gatewayBytesOut;
      if (nodeTotal !== gwTotal) {
        this.log.info("stream byte mismatch", { nodeId, stream: r.streamId, gatewayBytes: gwTotal, nodeBytes: nodeTotal });
      }
    }
    try {
      this.deps.onStreamClose?.(nodeId, r);
    } catch {
      /* never break the data path */
    }
  }

  onTunnelClosed(t: NodeTunnel, wasReady: boolean): void {
    this.tunnels.delete(t);
    const removed = this.registry.remove(t.node.id, t);
    if (removed) this.releaseSlot(t.node.id);
    if (wasReady && removed) {
      this.deps.markOffline(t.node.id).catch(() => undefined);
      this.log.info("node tunnel closed", { nodeId: t.node.id });
    }
  }

  /** Push a new policy to every ready tunnel and tighten mux stream caps. */
  pushPolicy(policy: ActivePolicy): void {
    for (const t of this.tunnels) {
      if (t.live) t.mux.maxStreams = Math.max(1, Math.min(t.live.maxStreams, policy.body.nodeDefaults.maxStreams));
      t.pushPolicy(policy);
    }
  }
}
