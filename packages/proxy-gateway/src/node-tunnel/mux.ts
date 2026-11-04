/**
 * Gateway-side stream mux for one node tunnel (DESIGN.md §2.3, §2.5).
 *
 * Streams are allocated by the gateway only (odd ids). `openStream(host, port)`
 * sends OPEN and resolves with a Duplex once the node answers OPEN_OK. Flow
 * control is honoured in both directions:
 *   - send: never exceed the node-granted credit (initial window + WINDOW grants);
 *     writes block (callback deferred) until credit arrives.
 *   - receive: the node may have at most `initialWindow` un-granted bytes in
 *     flight; we grant WINDOW credit as the consumer drains the readable side,
 *     once half a window has been consumed. Excess -> RST.
 * CLOSE frames carry the node's byte counts; together with the gateway's own
 * counts they are reported through `onStreamClose` for dispute records.
 */
import { Duplex } from "node:stream";
import {
  FrameType,
  encodeFrame,
  encodeControl,
  decodeControl,
  TunnelProtocolError,
  MAX_FRAME_PAYLOAD,
  FLAG_FIN,
  FLAG_RST,
  type Frame,
} from "@dominusnode/shared";

export const STREAM_WINDOW = 256 * 1024;
export const OPEN_TIMEOUT_MS = 10_000;
const MAX_STREAM_ID = 0x7fffffff;

export type OpenErrCode = "FLOOR_BLOCKED" | "PORT_BLOCKED" | "DNS_FAIL" | "DIAL_FAIL" | "CAP_EXCEEDED";
const OPEN_ERR_CODES: readonly string[] = ["FLOOR_BLOCKED", "PORT_BLOCKED", "DNS_FAIL", "DIAL_FAIL", "CAP_EXCEEDED"];

export interface OpenErrorMapping {
  status: number;
  code: string;
  /** Whether the caller may retry once on another node (§4 step 5). */
  retryable: boolean;
}

/** Map a node OPEN_ERR (or local failure) code to the gateway's HTTP contract. */
export function mapOpenError(code: string): OpenErrorMapping {
  switch (code) {
    case "FLOOR_BLOCKED":
    case "PORT_BLOCKED":
      return { status: 403, code, retryable: false };
    case "DNS_FAIL":
    case "DIAL_FAIL":
      return { status: 502, code, retryable: true };
    case "CAP_EXCEEDED":
      return { status: 503, code, retryable: true };
    case "TIMEOUT":
      return { status: 504, code, retryable: true };
    default:
      return { status: 502, code: "TUNNEL_ERROR", retryable: false };
  }
}

export class TunnelOpenError extends Error {
  readonly mapping: OpenErrorMapping;
  constructor(readonly code: string) {
    super(`tunnel open failed: ${code}`);
    this.name = "TunnelOpenError";
    this.mapping = mapOpenError(code);
  }
}

export interface StreamCloseReport {
  streamId: number;
  host: string;
  port: number;
  /** Gateway-measured bytes sent to the node (requester -> target). */
  gatewayBytesOut: number;
  /** Gateway-measured bytes received from the node (target -> requester). */
  gatewayBytesIn: number;
  /** Node-reported counts from its CLOSE frame (node bytesIn = our out, node bytesOut = our in), if any. */
  nodeReport: { bytesIn: number; bytesOut: number; reason: string } | null;
  reason: string;
}

export interface MuxOptions {
  send: (frame: Buffer) => void;
  /** Concurrent stream limit: min(node caps, policy caps). */
  maxStreams: number;
  initialWindow?: number;
  openTimeoutMs?: number;
  onStreamClose?: (r: StreamCloseReport) => void;
}

interface PendingOpen {
  resolve: (d: Duplex) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function nonNegInt(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

export class MuxStream extends Duplex {
  sendCredit: number;
  bytesOut = 0;
  bytesIn = 0;
  /** Total bytes the node may send = granted + initialWindow. */
  private granted = 0;
  private pushedTotal = 0;
  private grantScheduled = false;
  private blocked: { chunk: Buffer; cb: (e?: Error | null) => void } | null = null;
  finished = false;
  /** We sent CLOSE FIN (requester -> target direction done). */
  localFin = false;
  /** Node sent CLOSE FIN (target -> requester direction done); our write side stays open. */
  remoteFin = false;
  nodeReport: StreamCloseReport["nodeReport"] = null;

  constructor(
    readonly id: number,
    readonly host: string,
    readonly port: number,
    private readonly mux: TunnelMux,
    readonly window: number,
  ) {
    super({ readableHighWaterMark: window, writableHighWaterMark: window, allowHalfOpen: true });
    this.sendCredit = window;
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    if (this.finished) return cb(new Error("stream closed"));
    this.blocked = { chunk, cb };
    this.flush();
  }

  /** Send as much of the blocked chunk as credit allows; complete the write when done. */
  flush(): void {
    const b = this.blocked;
    if (!b) return;
    if (this.finished) {
      this.blocked = null;
      return b.cb(new Error("stream closed"));
    }
    while (b.chunk.length > 0 && this.sendCredit > 0) {
      const n = Math.min(this.sendCredit, MAX_FRAME_PAYLOAD, b.chunk.length);
      this.mux.sendFrame(FrameType.DATA, this.id, 0, b.chunk.subarray(0, n));
      b.chunk = b.chunk.subarray(n);
      this.sendCredit -= n;
      this.bytesOut += n;
    }
    if (b.chunk.length === 0) {
      this.blocked = null;
      b.cb();
    }
  }

  _final(cb: (e?: Error | null) => void): void {
    if (!this.finished && !this.localFin) {
      this.localFin = true;
      this.mux.sendControl(FrameType.CLOSE, this.id,
        { bytesIn: this.bytesIn, bytesOut: this.bytesOut, reason: "fin" }, FLAG_FIN);
      // Both directions shut down: the stream is complete.
      if (this.remoteFin) this.mux.finishStream(this, "fin", false);
    }
    cb();
  }

  _read(): void {
    this.maybeGrant();
  }

  _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    if (!this.finished) this.mux.finishStream(this, "gateway_rst", true);
    const b = this.blocked;
    this.blocked = null;
    if (b) b.cb(err ?? new Error("stream destroyed"));
    cb(err);
  }

  /** Incoming DATA. Returns false on a window violation. */
  receive(payload: Buffer): boolean {
    if (this.pushedTotal + payload.length > this.granted + this.window) return false;
    this.pushedTotal += payload.length;
    this.bytesIn += payload.length;
    this.push(payload);
    this.maybeGrant();
    // A flowing consumer drains the buffer asynchronously; re-check once it has.
    if (!this.grantScheduled) {
      this.grantScheduled = true;
      setImmediate(() => {
        this.grantScheduled = false;
        this.maybeGrant();
      });
    }
    return true;
  }

  private maybeGrant(): void {
    if (this.finished) return;
    const consumed = this.pushedTotal - this.readableLength;
    const delta = consumed - this.granted;
    if (delta >= this.window / 2) {
      this.granted += delta;
      const credit = Buffer.alloc(4);
      credit.writeUInt32BE(delta, 0);
      this.mux.sendFrame(FrameType.WINDOW, this.id, 0, credit);
    }
  }

  addCredit(n: number): void {
    this.sendCredit = Math.min(this.window, this.sendCredit + n);
    this.flush();
  }
}

export class TunnelMux {
  private streams = new Map<number, MuxStream>();
  private pending = new Map<number, PendingOpen>();
  private nextId = 1;
  private closed = false;
  readonly initialWindow: number;
  private readonly openTimeoutMs: number;
  maxStreams: number;

  constructor(private readonly opts: MuxOptions) {
    this.initialWindow = opts.initialWindow ?? STREAM_WINDOW;
    this.openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    this.maxStreams = opts.maxStreams;
  }

  get openStreams(): number {
    return this.streams.size + this.pending.size;
  }

  sendFrame(type: FrameType, id: number, flags: number, payload: Buffer): void {
    if (!this.closed) this.opts.send(encodeFrame(type, id, flags, payload));
  }

  sendControl(type: FrameType, id: number, obj: Record<string, unknown>, flags = 0): void {
    this.sendFrame(type, id, flags, encodeControl(obj));
  }

  private allocId(): number {
    for (let i = 0; i < 1024; i++) {
      const id = this.nextId;
      this.nextId = this.nextId + 2 > MAX_STREAM_ID ? 1 : this.nextId + 2;
      if (!this.streams.has(id) && !this.pending.has(id)) return id;
    }
    throw new TunnelOpenError("CAP_EXCEEDED");
  }

  openStream(host: string, port: number): Promise<Duplex> {
    if (this.closed) return Promise.reject(new TunnelOpenError("DIAL_FAIL"));
    if (this.openStreams >= this.maxStreams) return Promise.reject(new TunnelOpenError("CAP_EXCEEDED"));
    if (typeof host !== "string" || host.length === 0 || host.length > 253) {
      return Promise.reject(new TunnelOpenError("DNS_FAIL"));
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new TunnelOpenError("PORT_BLOCKED"));
    const id = this.allocId();
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Tell the node to drop whatever it may still open for this id.
        this.sendControl(FrameType.CLOSE, id, { bytesIn: 0, bytesOut: 0, reason: "open_timeout" }, FLAG_RST);
        reject(new TunnelOpenError("TIMEOUT"));
      }, this.openTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        timer,
        reject,
        resolve: () => {
          const s = new MuxStream(id, host, port, this, this.initialWindow);
          this.streams.set(id, s);
          resolve(s);
        },
      });
      this.sendControl(FrameType.OPEN, id, { host, port });
    });
  }

  /** Handle a stream-level frame (stream id != 0). Protocol errors throw. */
  handleFrame(f: Frame): void {
    const id = f.streamId;
    if (id === 0 || id % 2 === 0) throw new TunnelProtocolError("invalid stream id");
    switch (f.type) {
      case FrameType.OPEN_OK: {
        const p = this.pending.get(id);
        if (!p) {
          // Late OPEN_OK (e.g. after our open timeout): the node holds a socket and a
          // stream slot for an id we have forgotten. Reset it so both are released.
          if (!this.streams.has(id)) this.resetUnknown(id, "unknown_stream");
          return;
        }
        this.pending.delete(id);
        clearTimeout(p.timer);
        return p.resolve(undefined as unknown as Duplex);
      }
      case FrameType.OPEN_ERR: {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        const c = decodeControl<{ code?: unknown }>(f.payload);
        const code = typeof c.code === "string" && OPEN_ERR_CODES.includes(c.code) ? c.code : "DIAL_FAIL";
        return p.reject(new TunnelOpenError(code));
      }
      case FrameType.DATA: {
        const s = this.streams.get(id);
        if (!s) {
          if (!this.pending.has(id)) this.resetUnknown(id, "unknown_stream");
          return;
        }
        if (s.finished) return;
        if (s.remoteFin || !s.receive(f.payload)) {
          this.sendControl(FrameType.CLOSE, id, { bytesIn: s.bytesOut, bytesOut: s.bytesIn, reason: "window_violation" }, FLAG_RST);
          this.finishStream(s, "window_violation", false);
          s.destroy(new Error("window violation"));
        }
        return;
      }
      case FrameType.WINDOW: {
        if (f.payload.length !== 4) throw new TunnelProtocolError("bad WINDOW payload");
        const s = this.streams.get(id);
        if (s) s.addCredit(f.payload.readUInt32BE(0));
        else if (!this.pending.has(id)) this.resetUnknown(id, "unknown_stream");
        return;
      }
      case FrameType.CLOSE: {
        const s = this.streams.get(id);
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new TunnelOpenError("DIAL_FAIL"));
        }
        if (!s) return;
        const c = decodeControl<{ bytesIn?: unknown; bytesOut?: unknown; reason?: unknown }>(f.payload);
        s.nodeReport = {
          bytesIn: nonNegInt(c.bytesIn),
          bytesOut: nonNegInt(c.bytesOut),
          reason: typeof c.reason === "string" ? c.reason.slice(0, 64) : "",
        };
        if (f.flags & FLAG_RST) {
          // The node has forgotten the stream once it sends RST: no reply.
          this.finishStream(s, "node_rst", false);
          s.destroy(new Error("stream reset by node"));
          return;
        }
        // FIN is a one-way shutdown: end our readable side, keep writing upstream
        // until the requester finishes too (then _final sends our FIN).
        if (s.remoteFin) return;
        s.remoteFin = true;
        s.push(null);
        if (s.localFin) this.finishStream(s, "node_fin", false);
        return;
      }
      default:
        throw new TunnelProtocolError("unexpected stream frame");
    }
  }

  /** RST a stream id we have no record of (bounded: at most one per late node frame). */
  private resetUnknown(id: number, reason: string): void {
    this.sendControl(FrameType.CLOSE, id, { bytesIn: 0, bytesOut: 0, reason }, FLAG_RST);
  }

  /** Remove a stream; optionally send RST; report byte counts once. */
  finishStream(s: MuxStream, reason: string, sendRst: boolean): void {
    if (s.finished) return;
    s.finished = true;
    this.streams.delete(s.id);
    if (sendRst) {
      this.sendControl(FrameType.CLOSE, s.id, { bytesIn: s.bytesIn, bytesOut: s.bytesOut, reason }, FLAG_RST);
    }
    s.flush(); // fail any blocked write
    try {
      this.opts.onStreamClose?.({
        streamId: s.id, host: s.host, port: s.port, gatewayBytesOut: s.bytesOut, gatewayBytesIn: s.bytesIn,
        nodeReport: s.nodeReport, reason,
      });
    } catch {
      /* reporting must never break the data path */
    }
  }

  /** Tunnel gone: reject pending opens and reset all streams (they settle with gateway bytes). */
  closeAll(reason = "tunnel_closed"): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TunnelOpenError("DIAL_FAIL"));
      this.pending.delete(id);
    }
    for (const s of [...this.streams.values()]) {
      this.finishStream(s, reason, false);
      s.destroy(new Error(reason));
    }
    this.closed = true;
  }
}
