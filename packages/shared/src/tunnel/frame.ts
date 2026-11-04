/**
 * Agent-network tunnel frame codec (DESIGN.md §2.2–2.3).
 *
 * Header (big-endian, 12 bytes):
 *   u8 version (=1) | u8 type | u32 streamId | u16 flags | u32 length (<= 65536)
 */

export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 12;
export const MAX_FRAME_PAYLOAD = 65536;
export const MAX_CONTROL_PAYLOAD = 4096;
/** Max bytes buffered by a decoder: one maximal frame plus header. */
export const MAX_DECODER_BUFFER = FRAME_HEADER_SIZE + MAX_FRAME_PAYLOAD;

export const FLAG_FIN = 0x1;
export const FLAG_RST = 0x2;

export enum FrameType {
  HELLO = 0x01,
  CHALLENGE = 0x02,
  AUTH = 0x03,
  AUTH_OK = 0x04,
  AUTH_FAIL = 0x05,
  OPEN = 0x10,
  OPEN_OK = 0x11,
  OPEN_ERR = 0x12,
  DATA = 0x13,
  WINDOW = 0x14,
  CLOSE = 0x15,
  PING = 0x20,
  PONG = 0x21,
  DRAIN = 0x22,
  POLICY_UPDATE = 0x23,
}

const KNOWN_TYPES: ReadonlySet<number> = new Set(
  Object.values(FrameType).filter((v): v is number => typeof v === "number"),
);

export interface Frame {
  version: number;
  type: FrameType;
  streamId: number;
  flags: number;
  payload: Buffer;
}

export class TunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelProtocolError";
  }
}

function assertUint(name: string, v: number, max: number): void {
  if (!Number.isInteger(v) || v < 0 || v > max) {
    throw new TunnelProtocolError(`invalid ${name}`);
  }
}

export function encodeFrame(type: FrameType, streamId: number, flags: number, payload: Buffer): Buffer {
  if (!KNOWN_TYPES.has(type)) throw new TunnelProtocolError("unknown frame type");
  assertUint("streamId", streamId, 0xffffffff);
  assertUint("flags", flags, 0xffff);
  if (!Buffer.isBuffer(payload)) throw new TunnelProtocolError("payload must be a Buffer");
  if (payload.length > MAX_FRAME_PAYLOAD) throw new TunnelProtocolError("payload too large");
  const out = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.length);
  out.writeUInt8(FRAME_VERSION, 0);
  out.writeUInt8(type, 1);
  out.writeUInt32BE(streamId, 2);
  out.writeUInt16BE(flags, 6);
  out.writeUInt32BE(payload.length, 8);
  payload.copy(out, FRAME_HEADER_SIZE);
  return out;
}

/**
 * Incremental decoder. Buffers at most one partial frame (<= MAX_DECODER_BUFFER).
 * After a TunnelProtocolError the decoder is poisoned and further push() calls throw.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private pending = 0;
  /** Bytes needed before the next parse attempt is worthwhile. */
  private need = FRAME_HEADER_SIZE;
  private failed = false;

  get bufferedBytes(): number {
    return this.pending;
  }

  push(chunk: Buffer): Frame[] {
    if (this.failed) throw new TunnelProtocolError("decoder in failed state");
    if (chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.pending += chunk.length;
    if (this.pending < this.need) {
      if (this.pending > MAX_DECODER_BUFFER) this.fail("decoder buffer overflow");
      return [];
    }
    const data = this.chunks.length === 1 ? chunk : Buffer.concat(this.chunks, this.pending);
    const frames: Frame[] = [];
    let off = 0;
    this.need = FRAME_HEADER_SIZE;
    try {
      while (data.length - off >= FRAME_HEADER_SIZE) {
        const version = data.readUInt8(off);
        if (version !== FRAME_VERSION) throw new TunnelProtocolError(`unsupported version ${version}`);
        const type = data.readUInt8(off + 1);
        if (!KNOWN_TYPES.has(type)) throw new TunnelProtocolError(`unknown frame type 0x${type.toString(16)}`);
        const length = data.readUInt32BE(off + 8);
        if (length > MAX_FRAME_PAYLOAD) throw new TunnelProtocolError("frame length exceeds limit");
        if (data.length - off < FRAME_HEADER_SIZE + length) {
          this.need = FRAME_HEADER_SIZE + length;
          break;
        }
        const start = off + FRAME_HEADER_SIZE;
        frames.push({
          version,
          type: type as FrameType,
          streamId: data.readUInt32BE(off + 2),
          flags: data.readUInt16BE(off + 6),
          // Copy so frames don't pin the (possibly large) input buffer.
          payload: Buffer.from(data.subarray(start, start + length)),
        });
        off = start + length;
      }
    } catch (err) {
      this.failed = true;
      this.chunks = [];
      this.pending = 0;
      throw err;
    }
    const rest = data.subarray(off);
    if (rest.length > MAX_DECODER_BUFFER) this.fail("decoder buffer overflow");
    this.chunks = rest.length ? [Buffer.from(rest)] : [];
    this.pending = rest.length;
    return frames;
  }

  reset(): void {
    this.chunks = [];
    this.pending = 0;
    this.need = FRAME_HEADER_SIZE;
    this.failed = false;
  }

  private fail(msg: string): never {
    this.failed = true;
    this.chunks = [];
    this.pending = 0;
    throw new TunnelProtocolError(msg);
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_STRIP_DEPTH = 32;

/** Recursively remove prototype-pollution keys. */
export function stripDangerousKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_STRIP_DEPTH) throw new TunnelProtocolError("control payload too deeply nested");
  if (Array.isArray(value)) return value.map((v) => stripDangerousKeys(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = stripDangerousKeys(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function encodeControl(obj: unknown): Buffer {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TunnelProtocolError("control payload must be a JSON object");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(stripDangerousKeys(obj));
  } catch {
    throw new TunnelProtocolError("control payload not serializable");
  }
  if (json === undefined) throw new TunnelProtocolError("control payload not serializable");
  const buf = Buffer.from(json, "utf8");
  if (buf.length > MAX_CONTROL_PAYLOAD) throw new TunnelProtocolError("control payload too large");
  return buf;
}

export function decodeControl<T = Record<string, unknown>>(payload: Buffer): T {
  if (payload.length > MAX_CONTROL_PAYLOAD) throw new TunnelProtocolError("control payload too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new TunnelProtocolError("invalid control JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TunnelProtocolError("control payload must be a JSON object");
  }
  return stripDangerousKeys(parsed) as T;
}
