import type * as net from "node:net";
import type { Readable } from "node:stream";

export interface ByteCounter {
  bytesIn: number;
  bytesOut: number;
  /** Max total bytes allowed before onLimitExceeded fires. 0 = unlimited. */
  maxBytes: number;
  /** Called once when maxBytes is exceeded — should destroy the sockets */
  onLimitExceeded: (() => void) | null;
}

type PushFn = (chunk: unknown, encoding?: BufferEncoding) => boolean;

/**
 * Admission control at the read source: wrap `stream.push` so a chunk that
 * would take the session past `maxBytes()` is truncated to the remaining room
 * (bytes beyond the cap never enter the stream, so they are neither forwarded
 * nor billed) and `onOverflow` fires. `used()` is the session total so far
 * (both directions); `admit(n)` records n admitted bytes.
 * No-op for objects without a push method.
 */
export function capReadable(
  stream: unknown,
  used: () => number,
  admit: (n: number) => void,
  maxBytes: () => number,
  onOverflow: () => void,
): void {
  const s = stream as { push?: PushFn };
  if (typeof s.push !== "function") return;
  const orig = s.push.bind(stream) as PushFn;
  s.push = (chunk: unknown, encoding?: BufferEncoding): boolean => {
    if (chunk === null || chunk === undefined) return orig(chunk, encoding);
    const buf = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk instanceof Uint8Array ? chunk : null;
    if (!buf) return orig(chunk, encoding);
    const max = maxBytes();
    if (max <= 0 || used() + buf.length <= max) {
      admit(buf.length);
      return orig(buf);
    }
    const room = Math.max(0, max - used());
    if (room > 0) {
      admit(room);
      orig(Buffer.from(buf.buffer, buf.byteOffset, room));
    }
    onOverflow();
    return false;
  };
}

export function attachByteCounters(
  clientSocket: net.Socket | Readable,
  upstreamSocket: net.Socket | Readable,
): ByteCounter {
  const counter: ByteCounter = { bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null };
  let limitFired = false;

  function fireLimit(): void {
    if (limitFired || counter.maxBytes <= 0 || !counter.onLimitExceeded) return;
    limitFired = true;
    // Pause streams before limit callback to prevent TCP window overshoot
    try { (clientSocket as net.Socket).pause(); } catch { /* best effort */ }
    try { (upstreamSocket as net.Socket).pause(); } catch { /* best effort */ }
    counter.onLimitExceeded();
  }

  function checkLimit(): void {
    if (counter.bytesIn + counter.bytesOut > counter.maxBytes) fireLimit();
  }

  // Only bytes that are actually forwarded are billed: a chunk crossing the
  // cap is truncated before it enters the stream, then the limit fires.
  let admitted = 0;
  const used = (): number => admitted;
  const admit = (n: number): void => { admitted += n; };
  capReadable(clientSocket, used, admit, () => counter.maxBytes, fireLimit);
  capReadable(upstreamSocket, used, admit, () => counter.maxBytes, fireLimit);

  clientSocket.on("data", (chunk: Buffer) => {
    counter.bytesIn += chunk.length;
    checkLimit();
  });
  // Adding a 'data' listener switches the stream to flowing mode. Pause it so that
  // client bytes arriving before the caller pipes to upstream stay buffered (and are
  // delivered + counted once pipe() resumes) instead of being counted and dropped.
  if (typeof (clientSocket as Readable).pause === "function") (clientSocket as Readable).pause();

  upstreamSocket.on("data", (chunk: Buffer) => {
    counter.bytesOut += chunk.length;
    checkLimit();
  });

  return counter;
}
