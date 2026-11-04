import { describe, it, expect } from "vitest";
import {
  FrameType, FrameDecoder, encodeFrame, encodeControl, decodeControl, TunnelProtocolError,
  MAX_FRAME_PAYLOAD, MAX_CONTROL_PAYLOAD, MAX_DECODER_BUFFER, FLAG_FIN, FLAG_RST, type Frame,
} from "./frame.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TYPES = Object.values(FrameType).filter((v): v is FrameType => typeof v === "number");

describe("frame codec", () => {
  it("has all §2.3 codes", () => {
    expect(TYPES.sort((a, b) => a - b)).toEqual(
      [0x01, 0x02, 0x03, 0x04, 0x05, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x20, 0x21, 0x22, 0x23]);
  });

  it("round-trips a frame with header layout", () => {
    const f = encodeFrame(FrameType.DATA, 7, FLAG_FIN | FLAG_RST, Buffer.from("hi"));
    expect([...f.subarray(0, 12)]).toEqual([1, 0x13, 0, 0, 0, 7, 0, 3, 0, 0, 0, 2]);
    const out = new FrameDecoder().push(f);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ version: 1, type: FrameType.DATA, streamId: 7, flags: 3 });
    expect(out[0].payload.toString()).toBe("hi");
  });

  it("accepts max payload, rejects larger on encode", () => {
    const big = Buffer.alloc(MAX_FRAME_PAYLOAD, 1);
    expect(new FrameDecoder().push(encodeFrame(FrameType.DATA, 1, 0, big))[0].payload.length).toBe(MAX_FRAME_PAYLOAD);
    expect(() => encodeFrame(FrameType.DATA, 1, 0, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(TunnelProtocolError);
    expect(() => encodeFrame(0x99 as FrameType, 1, 0, Buffer.alloc(0))).toThrow(TunnelProtocolError);
    expect(() => encodeFrame(FrameType.DATA, -1, 0, Buffer.alloc(0))).toThrow(TunnelProtocolError);
    expect(() => encodeFrame(FrameType.DATA, 1, 0x10000, Buffer.alloc(0))).toThrow(TunnelProtocolError);
  });

  it("rejects bad version, unknown type, oversize length; poisons decoder", () => {
    const good = encodeFrame(FrameType.PING, 0, 0, Buffer.alloc(0));
    const badV = Buffer.from(good); badV[0] = 2;
    const badT = Buffer.from(good); badT[1] = 0x7f;
    const badL = Buffer.from(good); badL.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 8);
    for (const b of [badV, badT, badL]) {
      const d = new FrameDecoder();
      expect(() => d.push(b)).toThrow(TunnelProtocolError);
      expect(() => d.push(good)).toThrow(TunnelProtocolError);
    }
    // oversize length detected from header alone, without buffering payload
    const d = new FrameDecoder();
    expect(() => d.push(badL.subarray(0, 12))).toThrow(TunnelProtocolError);
  });

  it("fuzz: random frames, random split/coalesce produce identical output", () => {
    const r = rng(0xd0e1);
    for (let iter = 0; iter < 200; iter++) {
      const frames: Frame[] = [];
      const n = 1 + Math.floor(r() * 20);
      for (let i = 0; i < n; i++) {
        const len = r() < 0.03 ? MAX_FRAME_PAYLOAD : Math.floor(r() * 300);
        const payload = Buffer.alloc(len, Math.floor(r() * 256));
        for (let j = 0; j < Math.min(len, 300); j++) payload[j] = Math.floor(r() * 256);
        frames.push({ version: 1, type: TYPES[Math.floor(r() * TYPES.length)], streamId: Math.floor(r() * 0xffffffff),
          flags: Math.floor(r() * 0x10000), payload });
      }
      const wire = Buffer.concat(frames.map((f) => encodeFrame(f.type, f.streamId, f.flags, f.payload)));
      const d = new FrameDecoder();
      const got: Frame[] = [];
      let off = 0;
      while (off < wire.length) {
        const sz = r() < 0.3 ? 1 + Math.floor(r() * 3) : 1 + Math.floor(r() * 4000);
        got.push(...d.push(wire.subarray(off, off + sz)));
        off += sz;
        if (d.bufferedBytes > MAX_DECODER_BUFFER) throw new Error("buffer bound exceeded");
      }
      expect(d.bufferedBytes).toBe(0);
      expect(got.length).toBe(frames.length);
      got.forEach((g, i) => {
        const f = frames[i];
        expect([g.version, g.type, g.streamId, g.flags]).toEqual([f.version, f.type, f.streamId, f.flags]);
        expect(g.payload.equals(f.payload)).toBe(true);
      });
    }
  });

  it("fuzz: random garbage never crashes with non-protocol errors and stays bounded", () => {
    const r = rng(42);
    for (let iter = 0; iter < 500; iter++) {
      const len = Math.floor(r() * 200);
      const g = Buffer.alloc(len);
      for (let j = 0; j < len; j++) g[j] = Math.floor(r() * 256);
      if (r() < 0.5 && len > 0) g[0] = 1;
      const d = new FrameDecoder();
      try {
        d.push(g);
        expect(d.bufferedBytes).toBeLessThanOrEqual(MAX_DECODER_BUFFER);
      } catch (e) {
        expect(e).toBeInstanceOf(TunnelProtocolError);
      }
    }
  });
});

describe("control payloads", () => {
  it("round-trips and strips dangerous keys recursively", () => {
    const raw = Buffer.from('{"a":1,"__proto__":{"x":1},"n":{"constructor":2,"b":[{"prototype":3,"c":4}]}}');
    const v = decodeControl<Record<string, unknown>>(raw);
    expect(v).toEqual({ a: 1, n: { b: [{ c: 4 }] } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(decodeControl(encodeControl({ seq: 1, ts: 2 }))).toEqual({ seq: 1, ts: 2 });
  });

  it("enforces 4 KiB cap and rejects invalid JSON / non-objects", () => {
    expect(() => encodeControl({ s: "x".repeat(MAX_CONTROL_PAYLOAD) })).toThrow(TunnelProtocolError);
    expect(() => decodeControl(Buffer.alloc(MAX_CONTROL_PAYLOAD + 1, 0x20))).toThrow(TunnelProtocolError);
    expect(() => decodeControl(Buffer.from("{nope"))).toThrow(TunnelProtocolError);
    expect(() => decodeControl(Buffer.from("[1]"))).toThrow(TunnelProtocolError);
    expect(() => decodeControl(Buffer.from("null"))).toThrow(TunnelProtocolError);
  });
});

describe("encodeControl input validation", () => {
  it("rejects non-object payloads with TunnelProtocolError", () => {
    for (const v of [[1], "x", 1, null, true, undefined]) {
      expect(() => encodeControl(v)).toThrow(TunnelProtocolError);
    }
  });

  it("wraps JSON.stringify errors (BigInt, cycles) as TunnelProtocolError", () => {
    expect(() => encodeControl({ n: 1n })).toThrow(TunnelProtocolError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => encodeControl(cyc)).toThrow(TunnelProtocolError);
  });

  it("round-trips a plain object", () => {
    expect(decodeControl(encodeControl({ a: 1 }))).toEqual({ a: 1 });
  });
});
