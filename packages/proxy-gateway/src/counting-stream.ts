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

export function attachByteCounters(
  clientSocket: net.Socket | Readable,
  upstreamSocket: net.Socket | Readable,
): ByteCounter {
  const counter: ByteCounter = { bytesIn: 0, bytesOut: 0, maxBytes: 0, onLimitExceeded: null };
  let limitFired = false;

  function checkLimit(): void {
    if (limitFired || counter.maxBytes <= 0 || !counter.onLimitExceeded) return;
    if (counter.bytesIn + counter.bytesOut > counter.maxBytes) {
      limitFired = true;
      // Pause streams before limit callback to prevent TCP window overshoot
      try { (clientSocket as net.Socket).pause(); } catch { /* best effort */ }
      try { (upstreamSocket as net.Socket).pause(); } catch { /* best effort */ }
      counter.onLimitExceeded();
    }
  }

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
