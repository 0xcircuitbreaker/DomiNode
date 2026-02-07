import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { attachByteCounters } from "./counting-stream.js";
import type { ByteCounter } from "./counting-stream.js";

// Create a mock socket-like object (EventEmitter with 'data' events)
function createMockSocket(): EventEmitter {
  return new EventEmitter();
}

describe("proxy-gateway/counting-stream", () => {
  describe("ByteCounter interface", () => {
    it("should have bytesIn and bytesOut properties", () => {
      const counter: ByteCounter = { bytesIn: 0, bytesOut: 0 };
      expect(counter.bytesIn).toBe(0);
      expect(counter.bytesOut).toBe(0);
    });

    it("should be mutable", () => {
      const counter: ByteCounter = { bytesIn: 0, bytesOut: 0 };
      counter.bytesIn = 100;
      counter.bytesOut = 200;
      expect(counter.bytesIn).toBe(100);
      expect(counter.bytesOut).toBe(200);
    });
  });

  describe("attachByteCounters", () => {
    it("should return a ByteCounter with initial values of 0", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);
      expect(counter.bytesIn).toBe(0);
      expect(counter.bytesOut).toBe(0);
    });

    it("should count bytes from client socket as bytesIn", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      client.emit("data", Buffer.from("hello"));
      expect(counter.bytesIn).toBe(5);
      expect(counter.bytesOut).toBe(0);
    });

    it("should count bytes from upstream socket as bytesOut", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      upstream.emit("data", Buffer.from("response-data"));
      expect(counter.bytesIn).toBe(0);
      expect(counter.bytesOut).toBe(13);
    });

    it("should accumulate bytes from multiple data events on client", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      client.emit("data", Buffer.from("abc")); // 3 bytes
      client.emit("data", Buffer.from("defgh")); // 5 bytes
      client.emit("data", Buffer.from("i")); // 1 byte

      expect(counter.bytesIn).toBe(9);
    });

    it("should accumulate bytes from multiple data events on upstream", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      upstream.emit("data", Buffer.from("12")); // 2 bytes
      upstream.emit("data", Buffer.from("3456")); // 4 bytes
      upstream.emit("data", Buffer.from("789012345")); // 9 bytes

      expect(counter.bytesOut).toBe(15);
    });

    it("should track both bytesIn and bytesOut independently", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      client.emit("data", Buffer.from("request-data")); // 12 bytes
      upstream.emit("data", Buffer.from("response")); // 8 bytes
      client.emit("data", Buffer.from("more")); // 4 bytes
      upstream.emit("data", Buffer.from("done")); // 4 bytes

      expect(counter.bytesIn).toBe(16);
      expect(counter.bytesOut).toBe(12);
    });

    it("should handle empty buffers", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      client.emit("data", Buffer.alloc(0));
      upstream.emit("data", Buffer.alloc(0));

      expect(counter.bytesIn).toBe(0);
      expect(counter.bytesOut).toBe(0);
    });

    it("should handle large buffers", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      const largeBuffer = Buffer.alloc(1_000_000); // 1 MB
      client.emit("data", largeBuffer);
      upstream.emit("data", largeBuffer);

      expect(counter.bytesIn).toBe(1_000_000);
      expect(counter.bytesOut).toBe(1_000_000);
    });

    it("should count bytes correctly after many small chunks", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      for (let i = 0; i < 100; i++) {
        client.emit("data", Buffer.from("x")); // 1 byte each
      }

      expect(counter.bytesIn).toBe(100);
    });

    it("should return the same counter object (not a copy)", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);
      const ref = counter;

      client.emit("data", Buffer.from("test"));
      expect(ref.bytesIn).toBe(4); // same reference, updated value
    });

    it("should not interfere between different counter instances", () => {
      const client1 = createMockSocket();
      const upstream1 = createMockSocket();
      const client2 = createMockSocket();
      const upstream2 = createMockSocket();

      const counter1 = attachByteCounters(client1 as any, upstream1 as any);
      const counter2 = attachByteCounters(client2 as any, upstream2 as any);

      client1.emit("data", Buffer.from("aaa")); // 3 bytes
      client2.emit("data", Buffer.from("bbbbb")); // 5 bytes

      expect(counter1.bytesIn).toBe(3);
      expect(counter2.bytesIn).toBe(5);
    });

    it("should handle binary data correctly", () => {
      const client = createMockSocket();
      const upstream = createMockSocket();

      const counter = attachByteCounters(client as any, upstream as any);

      const binaryData = Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x80]);
      client.emit("data", binaryData);

      expect(counter.bytesIn).toBe(5);
    });
  });
});
