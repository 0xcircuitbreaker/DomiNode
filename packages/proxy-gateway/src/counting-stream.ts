import type * as net from "node:net";
import type { Readable } from "node:stream";

export interface ByteCounter {
  bytesIn: number;
  bytesOut: number;
}

export function attachByteCounters(
  clientSocket: net.Socket | Readable,
  upstreamSocket: net.Socket | Readable,
): ByteCounter {
  const counter: ByteCounter = { bytesIn: 0, bytesOut: 0 };

  clientSocket.on("data", (chunk: Buffer) => {
    counter.bytesIn += chunk.length;
  });

  upstreamSocket.on("data", (chunk: Buffer) => {
    counter.bytesOut += chunk.length;
  });

  return counter;
}
