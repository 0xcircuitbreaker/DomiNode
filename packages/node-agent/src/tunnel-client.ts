/**
 * Node tunnel client (DESIGN.md §2): one outbound WSS, our own mux framing.
 *
 * Handshake: WS upgrade with `Authorization: Bearer dn_node_…` -> HELLO -> CHALLENGE
 * -> (AUTH from commit 20) -> AUTH_OK. Streams are opened by the gateway only (odd
 * ids). Every OPEN goes through limits + floor-checked dialer; POLICY_UPDATE ports
 * are intersected with the floor and local ports. Logs carry metadata only.
 */
import { createHash, X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import type * as net from "node:net";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  FrameType, FrameDecoder, encodeFrame, encodeControl, decodeControl, TunnelProtocolError,
  MAX_FRAME_PAYLOAD, FLAG_FIN, FLAG_RST, type Frame,
  challengeMessage, authMessage, signEd25519, verifyEd25519, loadEd25519PrivateKey,
  EXPORTER_LABEL, EXPORTER_LENGTH,
} from "./shared.js";
import type { KeyObject } from "node:crypto";
import { effectivePorts, floorHash } from "./floor.js";
import type { Limits } from "./limits.js";
import type { DialResult, OpenErrCode } from "./dialer.js";

export const STREAM_WINDOW = 256 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const DRAIN_GRACE_MS = 30_000;
const MAX_MISSED_PONGS = 3;
const MAX_POLICY_PORTS = 64;

export interface TunnelLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const CRED_RE = /dn_(?:node|live|test|proxy)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
export function scrub(s: string): string {
  return s.replace(CRED_RE, "[REDACTED]");
}

export const stderrLogger: TunnelLogger = {
  info: (msg, meta) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...meta }) + "\n"),
  warn: (msg, meta) => process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg, ...meta }) + "\n"),
};

export type DialFn = (host: string, port: number, allowedPorts: readonly number[]) => Promise<DialResult>;

export interface TunnelClientOptions {
  url: string;
  nodeKey: string;
  nodeId: string;
  agentVersion: string;
  localPorts: readonly number[];
  caps: { maxStreams: number; maxMbps: number; gbPerDay: number };
  limits: Limits;
  dial: DialFn;
  logger?: TunnelLogger;
  /** PEM (pkcs8) ed25519 node key generated at registration; signs AUTH. */
  nodePrivateKeyPem: string;
  /** Coordinator ed25519 pubkeys (hex); CHALLENGE must be signed by one. Empty = refuse to auth. */
  coordPins: readonly string[];
  /** Base64 SHA-256 SPKI pins; when non-empty the server key must match one. */
  spkiPins?: readonly string[];
  backoffMinMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  /** Extra ws client options (e.g. `ca` for a private relay CA). */
  wsOptions?: Pick<WebSocket.ClientOptions, "ca">;
}

interface Stream {
  id: number;
  socket: net.Socket;
  host: string;
  port: number;
  sendCredit: number;
  /** Bytes read from the socket but not yet covered by peer credit (bounded: socket is paused while non-empty). */
  pending: Buffer | null;
  recvOutstanding: number;
  recvConsumed: number;
  bytesIn: number;
  bytesOut: number;
  closeSent: boolean;
  /** Target sent EOF and we forwarded CLOSE FIN; upstream DATA may still drain. */
  localFin: boolean;
}

/** An OPEN whose dial is still running; `cancelled` once the gateway gave up on it. */
interface PendingOpen {
  cancelled: boolean;
}

type State = "idle" | "connecting" | "handshake" | "ready" | "stopped";

/** Jittered exponential backoff in [min, max]: base = min*2^attempt, delay in [base/2, base]. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.max(minMs, Math.min(maxMs, Math.round(base / 2 + random() * (base / 2))));
}

export function spkiFingerprint(cert: PeerCertificate): string | null {
  try {
    const x = new X509Certificate(cert.raw);
    const der = x.publicKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("base64");
  } catch {
    return null;
  }
}

export class TunnelClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: State = "idle";
  private decoder = new FrameDecoder();
  private streams = new Map<number, Stream>();
  /** Per-connection: replaced (never mutated across) on reconnect, so stale dials cannot collide. */
  private pendingOpens = new Map<number, PendingOpen>();
  private policyPorts: number[];
  private initialWindow = STREAM_WINDOW;
  private heartbeatMs = 15_000;
  private pingTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private pingSeq = 0;
  private attempt = 0;
  private draining = false;
  private keyBuf: Buffer;
  private readonly signKey: KeyObject;
  private challenged = false;
  /** AUTH was sent in answer to a pin-verified CHALLENGE on this connection. */
  private authSent = false;
  private readonly log: TunnelLogger;

  constructor(private readonly opts: TunnelClientOptions) {
    super();
    if (!/^dn_node_[0-9a-f]{64}$/.test(opts.nodeKey)) throw new Error("invalid node key format");
    this.keyBuf = Buffer.from(opts.nodeKey, "utf8");
    this.signKey = loadEd25519PrivateKey(opts.nodePrivateKeyPem);
    this.log = opts.logger ?? stderrLogger;
    // Until the gateway says otherwise, the policy side admits only the floor ports.
    this.policyPorts = [80, 443];
  }

  get currentState(): State {
    return this.state;
  }

  /** Ports this node will dial right now: FLOOR ∩ policy ∩ local. */
  get allowedPorts(): number[] {
    return effectivePorts(this.policyPorts, this.opts.localPorts);
  }

  get activeStreamCount(): number {
    return this.streams.size;
  }

  start(): void {
    if (this.state === "stopped") throw new Error("client stopped");
    if (this.state !== "idle") return;
    this.connect();
  }

  /** Close the tunnel and zeroize the key buffer. The client cannot be restarted. */
  stop(): void {
    this.state = "stopped";
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resetStreams();
    this.cancelPendingOpens();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => undefined);
      this.ws.terminate();
      this.ws = null;
    }
    this.keyBuf.fill(0);
    this.emit("stopped");
  }

  /** RFC 5705 exporter of the live WSS connection (same label as the gateway). */
  private tlsExporter(): Buffer | null {
    const sock = (this.ws as unknown as { _socket?: { exportKeyingMaterial?: (n: number, l: string) => Buffer } } | null)?._socket;
    if (!sock || typeof sock.exportKeyingMaterial !== "function") return null;
    try {
      const b = sock.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL);
      return b.length === EXPORTER_LENGTH ? b : null;
    } catch {
      return null;
    }
  }

  private connect(): void {
    this.state = "connecting";
    this.decoder = new FrameDecoder();
    this.draining = false;
    this.cancelPendingOpens();
    const pins = this.opts.spkiPins ?? [];
    const ws = new WebSocket(this.opts.url, {
      headers: { Authorization: `Bearer ${this.keyBuf.toString("utf8")}` },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_PAYLOAD + 12,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      ...(this.opts.wsOptions ?? {}),
      ...(pins.length > 0
        ? {
            checkServerIdentity: (_host: string, cert: PeerCertificate): Error | undefined => {
              const fp = spkiFingerprint(cert);
              return fp && pins.includes(fp) ? undefined : new Error("SPKI pin mismatch");
            },
          }
        : {}),
    });
    this.ws = ws;
    ws.binaryType = "nodebuffer";
    this.handshakeTimer = setTimeout(() => this.fail("handshake timeout"), HANDSHAKE_TIMEOUT_MS);

    ws.on("open", () => {
      this.state = "handshake";
      this.challenged = false;
      this.authSent = false;
      this.sendControl(FrameType.HELLO, 0, {
        nodeId: this.opts.nodeId,
        agentVersion: this.opts.agentVersion,
        caps: { ...this.opts.caps, maxStreams: this.opts.limits.values.maxStreams, ports: this.allowedPorts },
        floorHash: floorHash(this.opts.agentVersion),
      });
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      // Once we fail() a connection it is CLOSING: frames the peer keeps sending (e.g. an AUTH_OK
      // racing our close after a protocol error) must never be acted on.
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!isBinary) return this.fail("text message", 1003);
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      let frames: Frame[];
      try {
        frames = this.decoder.push(buf);
      } catch (e) {
        return this.fail(e instanceof TunnelProtocolError ? "protocol error" : "decode error", 1002);
      }
      for (const f of frames) {
        if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          this.onFrame(f);
        } catch (e) {
          return this.fail(e instanceof TunnelProtocolError ? "protocol error" : "frame handling error", 1002);
        }
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      this.log.warn("tunnel upgrade rejected", { status: res.statusCode });
      this.emit("rejected", res.statusCode);
      ws.terminate();
    });
    ws.on("error", (err: Error) => {
      this.log.warn("tunnel error", { error: scrub(err.message) });
    });
    ws.on("close", (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onDisconnected(code);
    });
  }

  private onDisconnected(code: number): void {
    this.clearTimers();
    this.resetStreams();
    this.cancelPendingOpens();
    this.emit("disconnected", code);
    if (this.state === "stopped") return;
    this.state = "idle";
    const delay = backoffDelay(this.attempt++, this.opts.backoffMinMs ?? 1000, this.opts.backoffMaxMs ?? 60_000,
      this.opts.random ?? Math.random);
    this.log.info("tunnel reconnect scheduled", { delayMs: delay, closeCode: code });
    this.emit("reconnecting", delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === "idle") this.connect();
    }, delay);
  }

  private fail(reason: string, code = 1008): void {
    this.log.warn("tunnel closing", { reason });
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(code, reason.slice(0, 100));
    } catch {
      ws.terminate();
    }
    // Make sure we do not wait forever on a peer that ignores the close.
    setTimeout(() => ws.terminate(), 2000).unref();
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.handshakeTimer, this.drainTimer]) if (t) clearTimeout(t);
    this.pingTimer = this.handshakeTimer = this.drainTimer = null;
  }

  /** Stale dials from a previous connection must never answer on (or collide with) a new one. */
  private cancelPendingOpens(): void {
    for (const p of this.pendingOpens.values()) p.cancelled = true;
    this.pendingOpens = new Map();
  }

  private resetStreams(): void {
    for (const s of this.streams.values()) {
      s.socket.removeAllListeners();
      s.socket.on("error", () => undefined);
      s.socket.destroy();
      this.opts.limits.release();
    }
    this.streams.clear();
  }

  private send(buf: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf, { binary: true });
  }

  private sendControl(type: FrameType, streamId: number, obj: Record<string, unknown>, flags = 0): void {
    this.send(encodeFrame(type, streamId, flags, encodeControl(obj)));
  }

  private onFrame(f: Frame): void {
    if (this.state === "handshake") return this.onHandshakeFrame(f);
    if (this.state !== "ready") throw new TunnelProtocolError("frame in unexpected state");
    switch (f.type) {
      case FrameType.OPEN: return this.onOpen(f);
      case FrameType.DATA: return this.onData(f);
      case FrameType.WINDOW: return this.onWindow(f);
      case FrameType.CLOSE: return this.onRemoteClose(f);
      case FrameType.PING:
        if (f.streamId !== 0) throw new TunnelProtocolError("PING on stream");
        return this.send(encodeFrame(FrameType.PONG, 0, 0, encodeControl(decodeControl(f.payload))));
      case FrameType.PONG:
        this.missedPongs = 0;
        return;
      case FrameType.DRAIN: return this.onDrain();
      case FrameType.POLICY_UPDATE: return this.onPolicyUpdate(f);
      default:
        throw new TunnelProtocolError("unexpected frame type");
    }
  }

  private onHandshakeFrame(f: Frame): void {
    if (f.streamId !== 0) throw new TunnelProtocolError("handshake frame on stream");
    if (f.type === FrameType.CHALLENGE) {
      if (this.challenged) throw new TunnelProtocolError("duplicate challenge");
      this.challenged = true;
      const c = decodeControl<{ nonce?: unknown; policyVersion?: unknown; serverTime?: unknown; binding?: unknown; coordSig?: unknown }>(f.payload);
      if (typeof c.nonce !== "string" || !/^[0-9a-f]{64}$/.test(c.nonce)) throw new TunnelProtocolError("bad challenge");
      if (typeof c.policyVersion !== "number" || !Number.isSafeInteger(c.policyVersion) || c.policyVersion < 0 ||
          typeof c.serverTime !== "number" || !Number.isSafeInteger(c.serverTime) || c.serverTime < 0) {
        throw new TunnelProtocolError("bad challenge");
      }
      const binding = c.binding === "tls-exporter" ? "tls-exporter" : c.binding === "none" ? "none" : null;
      if (!binding) throw new TunnelProtocolError("bad challenge binding");
      const msg = challengeMessage(c.nonce, c.policyVersion, c.serverTime, binding);
      const pins = this.opts.coordPins;
      if (pins.length === 0 || !pins.some((p) => verifyEd25519(p, msg, c.coordSig))) {
        this.log.warn("coordinator signature rejected");
        this.emit("authFail", "COORD_SIGNATURE");
        return this.fail("coordinator signature invalid");
      }
      let exporter: Buffer | null = null;
      if (binding === "tls-exporter") {
        exporter = this.tlsExporter();
        if (!exporter) return this.fail("tls exporter unavailable");
      }
      const sig = signEd25519(this.signKey, authMessage(c.nonce, this.opts.nodeId, exporter));
      this.sendControl(FrameType.AUTH, 0, { sig });
      this.authSent = true;
      return;
    }
    if (f.type === FrameType.AUTH_FAIL) {
      const c = decodeControl<{ code?: unknown }>(f.payload);
      const code = typeof c.code === "string" ? c.code.slice(0, 64) : "UNKNOWN";
      this.log.warn("tunnel auth failed", { code });
      this.emit("authFail", code);
      return this.fail("auth failed");
    }
    if (f.type === FrameType.AUTH_OK) {
      // Only a peer that proved the coordinator key (signed CHALLENGE) and received our AUTH may
      // move us to ready; otherwise any TLS endpoint could skip the coordinator pin entirely.
      if (!this.challenged || !this.authSent) throw new TunnelProtocolError("AUTH_OK before verified CHALLENGE");
      const a = decodeControl<{ heartbeatMs?: unknown; initialWindow?: unknown; policyHash?: unknown }>(f.payload);
      if (typeof a.heartbeatMs === "number" && Number.isFinite(a.heartbeatMs)) {
        this.heartbeatMs = Math.min(60_000, Math.max(5_000, Math.trunc(a.heartbeatMs)));
      }
      // The window can only shrink below our buffer budget.
      if (typeof a.initialWindow === "number" && Number.isInteger(a.initialWindow) && a.initialWindow >= MAX_FRAME_PAYLOAD) {
        this.initialWindow = Math.min(STREAM_WINDOW, a.initialWindow);
      }
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      this.state = "ready";
      this.attempt = 0;
      this.missedPongs = 0;
      this.startHeartbeat();
      this.log.info("tunnel ready", { policyHash: typeof a.policyHash === "string" ? a.policyHash.slice(0, 64) : null });
      this.emit("ready");
      return;
    }
    throw new TunnelProtocolError("unexpected pre-auth frame");
  }

  private startHeartbeat(): void {
    const tick = (): void => {
      if (this.state !== "ready") return;
      if (this.missedPongs >= MAX_MISSED_PONGS) return this.fail("heartbeat timeout", 1001);
      this.missedPongs++;
      this.sendControl(FrameType.PING, 0, { seq: ++this.pingSeq, ts: Date.now() });
      this.pingTimer = setTimeout(tick, this.heartbeatMs);
    };
    this.pingTimer = setTimeout(tick, this.heartbeatMs);
  }

  private openErr(id: number, code: OpenErrCode): void {
    this.sendControl(FrameType.OPEN_ERR, id, { code });
  }

  /** Synchronous validation (protocol errors close the tunnel), then the async dial. */
  private onOpen(f: Frame): void {
    const id = f.streamId;
    if (id === 0 || id % 2 === 0) throw new TunnelProtocolError("invalid stream id");
    if (this.streams.has(id) || this.pendingOpens.has(id)) throw new TunnelProtocolError("duplicate stream id");
    const req = decodeControl<{ host?: unknown; port?: unknown }>(f.payload);
    if (this.draining || !this.opts.limits.tryOpenStream()) return this.openErr(id, "CAP_EXCEEDED");
    const pend = this.pendingOpens;
    const entry: PendingOpen = { cancelled: false };
    pend.set(id, entry);
    this.dialAndOpen(id, req, entry).catch((e: unknown) => {
      this.log.warn("stream open failed", { stream: id, error: scrub(e instanceof Error ? e.message : String(e)) });
    }).finally(() => {
      // Only remove our own entry: the id may since belong to a newer open.
      if (pend.get(id) === entry) pend.delete(id);
    });
  }

  private async dialAndOpen(id: number, req: { host?: unknown; port?: unknown }, entry: PendingOpen): Promise<void> {
    const host = typeof req.host === "string" ? req.host : "";
    const port = typeof req.port === "number" ? req.port : -1;
    const ws = this.ws;
    let res: DialResult;
    try {
      res = await this.opts.dial(host, port, this.allowedPorts);
    } catch {
      res = { ok: false, code: "DIAL_FAIL" };
    }
    if (entry.cancelled) {
      // Gateway timed out / reset this open: it has forgotten the id. Free the slot, no OPEN_OK.
      this.opts.limits.release();
      if (res.ok) res.socket.destroy();
      return;
    }
    if (this.ws !== ws || this.state !== "ready" || this.draining) {
      this.opts.limits.release();
      if (res.ok) res.socket.destroy();
      if (this.ws === ws && this.state === "ready") this.openErr(id, "CAP_EXCEEDED");
      return;
    }
    if (!res.ok) {
      this.opts.limits.release();
      this.log.info("stream open refused", { stream: id, host: host.slice(0, 253), port, code: res.code });
      return this.openErr(id, res.code);
    }
    const s: Stream = {
      id, socket: res.socket, host, port, sendCredit: this.initialWindow, pending: null,
      recvOutstanding: 0, recvConsumed: 0, bytesIn: 0, bytesOut: 0, closeSent: false, localFin: false,
    };
    this.streams.set(id, s);
    this.sendControl(FrameType.OPEN_OK, id, {});
    this.log.info("stream open", { stream: id, host: host.slice(0, 253), port });
    const sock = res.socket;
    sock.on("data", (chunk: Buffer) => this.onSocketData(s, chunk));
    // Target EOF is a one-way shutdown: forward FIN but keep the stream so the
    // requester's remaining upload still drains to the target.
    sock.on("end", () => this.halfCloseStream(s));
    sock.on("error", () => this.closeStream(s, FLAG_RST, "socket_error"));
    sock.on("close", () => this.closeStream(s, FLAG_FIN, "closed"));
  }

  private onSocketData(s: Stream, chunk: Buffer): void {
    if (!this.streams.has(s.id)) return;
    if (!this.opts.limits.addBytes(chunk.length)) return this.closeStream(s, FLAG_RST, "gb_per_day");
    // Never exceed peer-granted credit: send what fits, hold the rest (at most one
    // socket chunk plus anything already in flight before pause took effect).
    s.pending = s.pending ? Buffer.concat([s.pending, chunk]) : chunk;
    this.flushPending(s);
  }

  private flushPending(s: Stream): void {
    while (s.pending && s.sendCredit > 0 && this.streams.has(s.id)) {
      const n = Math.min(s.sendCredit, MAX_FRAME_PAYLOAD, s.pending.length);
      const part = s.pending.subarray(0, n);
      s.pending = n === s.pending.length ? null : s.pending.subarray(n);
      this.send(encodeFrame(FrameType.DATA, s.id, 0, part));
      s.sendCredit -= n;
      s.bytesOut += n;
    }
    if (!this.streams.has(s.id)) return;
    if (s.localFin && !s.pending && !s.closeSent) {
      s.closeSent = true;
      this.sendControl(FrameType.CLOSE, s.id, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, reason: "eof" }, FLAG_FIN);
      return;
    }
    if (s.pending || s.sendCredit <= 0) {
      if (!s.socket.isPaused()) s.socket.pause();
    } else if (s.socket.isPaused()) {
      s.socket.resume();
    }
  }

  private onData(f: Frame): void {
    const s = this.streams.get(f.streamId);
    if (!s) return; // late DATA after close is harmless
    s.recvOutstanding += f.payload.length;
    if (s.recvOutstanding > this.initialWindow) return this.closeStream(s, FLAG_RST, "window_violation");
    s.bytesIn += f.payload.length;
    if (!this.opts.limits.addBytes(f.payload.length)) return this.closeStream(s, FLAG_RST, "gb_per_day");
    const n = f.payload.length;
    s.socket.write(f.payload, () => {
      if (!this.streams.has(s.id)) return;
      s.recvOutstanding -= n;
      s.recvConsumed += n;
      if (s.recvConsumed >= this.initialWindow / 2) {
        const credit = Buffer.alloc(4);
        credit.writeUInt32BE(s.recvConsumed, 0);
        s.recvConsumed = 0;
        this.send(encodeFrame(FrameType.WINDOW, s.id, 0, credit));
      }
    });
  }

  private onWindow(f: Frame): void {
    if (f.payload.length !== 4) throw new TunnelProtocolError("bad WINDOW payload");
    const s = this.streams.get(f.streamId);
    if (!s) return;
    s.sendCredit = Math.min(this.initialWindow, s.sendCredit + f.payload.readUInt32BE(0));
    this.flushPending(s);
  }

  private halfCloseStream(s: Stream): void {
    if (!this.streams.has(s.id) || s.localFin) return;
    s.localFin = true;
    // Flush whatever credit allows; anything still pending is sent as credit arrives
    // only if the stream is alive, so send FIN after the buffered tail when possible.
    if (!s.pending && !s.closeSent) {
      s.closeSent = true;
      this.sendControl(FrameType.CLOSE, s.id, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, reason: "eof" }, FLAG_FIN);
    }
  }

  private onRemoteClose(f: Frame): void {
    const s = this.streams.get(f.streamId);
    if (!s) {
      // OPEN still dialing: remember the cancel so a late success does not send OPEN_OK.
      const p = this.pendingOpens.get(f.streamId);
      if (p) p.cancelled = true;
      return;
    }
    if (f.flags & FLAG_RST) {
      s.closeSent = true; // peer reset: no reply
      return this.closeStream(s, FLAG_RST, "remote_rst");
    }
    s.socket.end();
  }

  private closeStream(s: Stream, flags: number, reason: string): void {
    if (!this.streams.has(s.id)) return;
    this.streams.delete(s.id);
    this.opts.limits.release();
    if (!s.closeSent) {
      s.closeSent = true;
      this.sendControl(FrameType.CLOSE, s.id, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, reason }, flags);
    }
    if (flags & FLAG_RST) s.socket.destroy();
    else s.socket.end();
    this.log.info("stream close", { stream: s.id, host: s.host.slice(0, 253), port: s.port,
      bytesIn: s.bytesIn, bytesOut: s.bytesOut, reason });
    if (this.draining && this.streams.size === 0) this.fail("drained", 1000);
  }

  private onDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.log.info("drain requested", { streams: this.streams.size });
    this.emit("drain");
    if (this.streams.size === 0) return this.fail("drained", 1000);
    this.drainTimer = setTimeout(() => {
      for (const s of [...this.streams.values()]) this.closeStream(s, FLAG_RST, "drain_timeout");
    }, DRAIN_GRACE_MS);
  }

  private onPolicyUpdate(f: Frame): void {
    if (f.streamId !== 0) throw new TunnelProtocolError("POLICY_UPDATE on stream");
    const u = decodeControl<{ ports?: unknown; policyVersion?: unknown }>(f.payload);
    if (!Array.isArray(u.ports) || u.ports.length > MAX_POLICY_PORTS) {
      this.log.warn("policy update ignored", { reason: "invalid ports" });
      return;
    }
    // Only integers survive; the floor intersection in effectivePorts() drops anything else.
    this.policyPorts = u.ports.filter((p): p is number => typeof p === "number" && Number.isInteger(p));
    this.log.info("policy updated", {
      policyVersion: typeof u.policyVersion === "number" ? u.policyVersion : null,
      ports: this.allowedPorts,
    });
    this.emit("policy", this.allowedPorts);
  }
}
