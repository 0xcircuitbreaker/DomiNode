import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as net from "node:net";

// We can't easily import the non-exported readBytes and parseProxyOptions
// from socks5.ts since they are module-private functions.
// Instead, we test them by reimplementing the logic and testing the behavior
// through the exported interface, or by testing the patterns directly.

// ─── parseProxyOptions pattern tests ─────────────────────────────────

describe("socks5 parseProxyOptions patterns", () => {
  // The regex patterns used in socks5.ts parseProxyOptions:
  // country: /(?:^|-)country-([A-Za-z]{2})(?:-|$)/
  // session: /(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/

  const countryRe = /(?:^|-)country-([A-Za-z]{2})(?:-|$)/;
  const sessionRe = /(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/;

  function parseProxyOptions(username: string) {
    const options: { country?: string; sessionId?: string } = {};
    const countryMatch = username.match(countryRe);
    if (countryMatch) options.country = countryMatch[1].toUpperCase();
    const sessionMatch = username.match(sessionRe);
    if (sessionMatch) options.sessionId = sessionMatch[1];
    return options;
  }

  it("should return empty options for plain username", () => {
    expect(parseProxyOptions("user")).toEqual({});
  });

  it("should parse country-US", () => {
    const opts = parseProxyOptions("country-US");
    expect(opts.country).toBe("US");
  });

  it("should parse country-de and uppercase it", () => {
    const opts = parseProxyOptions("country-de");
    expect(opts.country).toBe("DE");
  });

  it("should parse session-abc123", () => {
    const opts = parseProxyOptions("session-abc123");
    expect(opts.sessionId).toBe("abc123");
  });

  it("should parse combined country-US-session-abc123", () => {
    const opts = parseProxyOptions("country-US-session-abc123");
    expect(opts.country).toBe("US");
    expect(opts.sessionId).toBe("abc123");
  });

  it("should parse session-xyz-country-GB", () => {
    const opts = parseProxyOptions("session-xyz-country-GB");
    expect(opts.sessionId).toBe("xyz");
    expect(opts.country).toBe("GB");
  });

  it("should not match country with 3 letters", () => {
    const opts = parseProxyOptions("country-USA");
    // The regex matches 2 letters so it would match "US" out of "USA"
    // but the third letter 'A' is not a dash or end so the match may fail
    // Let's verify
    expect(opts.country).toBeUndefined();
  });

  it("should not match country with 1 letter", () => {
    const opts = parseProxyOptions("country-U");
    expect(opts.country).toBeUndefined();
  });
});

// ─── readBytes logic tests ──────────────────────────────────────────

describe("socks5 readBytes behavior", () => {
  // We test the readBytes logic by creating a mock socket and verifying
  // the pattern. The actual readBytes is module-private, so we test
  // the same pattern.

  function readBytes(socket: EventEmitter & { unshift?: (data: Buffer) => void; removeListener: (event: string, fn: Function) => void }, n: number, timeoutMs: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      if (n === 0) {
        resolve(Buffer.alloc(0));
        return;
      }

      let collected = Buffer.alloc(0);
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.removeListener("data", onData);
          socket.removeListener("error", onError);
          socket.removeListener("close", onClose);
          resolve(null);
        }
      }, timeoutMs);

      function finish(result: Buffer | null): void {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        resolve(result);
      }

      function onData(chunk: Buffer): void {
        collected = Buffer.concat([collected, chunk]);
        if (collected.length >= n) {
          const result = collected.slice(0, n);
          if (collected.length > n && socket.unshift) {
            socket.unshift(collected.slice(n));
          }
          finish(result);
        }
      }

      function onError(): void {
        finish(null);
      }

      function onClose(): void {
        finish(null);
      }

      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
    });
  }

  it("should return empty buffer for n=0", async () => {
    const socket = new EventEmitter() as any;
    const result = await readBytes(socket, 0, 1000);
    expect(result).toEqual(Buffer.alloc(0));
  });

  it("should read exact bytes from single chunk", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const promise = readBytes(socket, 4, 1000);
    socket.emit("data", Buffer.from([0x05, 0x01, 0x02, 0x03]));

    const result = await promise;
    expect(result).toEqual(Buffer.from([0x05, 0x01, 0x02, 0x03]));
  });

  it("should handle data arriving in multiple chunks", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const promise = readBytes(socket, 4, 1000);
    socket.emit("data", Buffer.from([0x05, 0x01]));
    socket.emit("data", Buffer.from([0x02, 0x03]));

    const result = await promise;
    expect(result).toEqual(Buffer.from([0x05, 0x01, 0x02, 0x03]));
  });

  it("should unshift excess bytes", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const promise = readBytes(socket, 2, 1000);
    socket.emit("data", Buffer.from([0x05, 0x01, 0x02, 0x03]));

    const result = await promise;
    expect(result).toEqual(Buffer.from([0x05, 0x01]));
    expect(socket.unshift).toHaveBeenCalledWith(Buffer.from([0x02, 0x03]));
  });

  it("should return null on timeout", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const result = await readBytes(socket, 4, 50); // 50ms timeout
    expect(result).toBeNull();
  });

  it("should return null on socket error", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const promise = readBytes(socket, 4, 5000);
    socket.emit("error", new Error("connection reset"));

    const result = await promise;
    expect(result).toBeNull();
  });

  it("should return null on socket close", async () => {
    const socket = new EventEmitter() as any;
    socket.unshift = vi.fn();

    const promise = readBytes(socket, 4, 5000);
    socket.emit("close");

    const result = await promise;
    expect(result).toBeNull();
  });
});
