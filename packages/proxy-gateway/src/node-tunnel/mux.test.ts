import { describe, it, expect } from "vitest";
import {
  FrameDecoder, FrameType, encodeFrame, encodeControl, decodeControl, FLAG_FIN, FLAG_RST, type Frame,
} from "@dominusnode/shared";
import { TunnelMux, TunnelOpenError, mapOpenError, type StreamCloseReport } from "./mux.js";

function setup(window = 65536, maxStreams = 4) {
  const out: Frame[] = [];
  const dec = new FrameDecoder();
  const reports: StreamCloseReport[] = [];
  const mux = new TunnelMux({
    send: (b) => out.push(...dec.push(b)), maxStreams, initialWindow: window, openTimeoutMs: 200,
    onStreamClose: (r) => reports.push(r),
  });
  const node = (type: FrameType, id: number, obj: unknown, flags = 0) =>
    mux.handleFrame(dec2(encodeFrame(type, id, flags, Buffer.isBuffer(obj) ? obj : encodeControl(obj))));
  return { out, mux, node, reports };
}
function dec2(b: Buffer): Frame {
  return new FrameDecoder().push(b)[0];
}
const tick = () => new Promise((r) => setImmediate(r));

describe("mapOpenError", () => {
  it("maps codes to the HTTP contract", () => {
    expect(mapOpenError("FLOOR_BLOCKED")).toEqual({ status: 403, code: "FLOOR_BLOCKED", retryable: false });
    expect(mapOpenError("PORT_BLOCKED").status).toBe(403);
    expect(mapOpenError("DIAL_FAIL")).toMatchObject({ status: 502, retryable: true });
    expect(mapOpenError("DNS_FAIL").retryable).toBe(true);
    expect(mapOpenError("CAP_EXCEEDED").status).toBe(503);
    expect(mapOpenError("weird")).toMatchObject({ code: "TUNNEL_ERROR", retryable: false });
  });
});

describe("TunnelMux", () => {
  it("allocates odd stream ids and sends OPEN", async () => {
    const { out, mux, node } = setup();
    const p1 = mux.openStream("example.com", 443);
    const p2 = mux.openStream("example.org", 80);
    expect(out.map((f) => f.streamId)).toEqual([1, 3]);
    expect(decodeControl(out[0].payload)).toEqual({ host: "example.com", port: 443 });
    node(FrameType.OPEN_OK, 1, {});
    node(FrameType.OPEN_ERR, 3, { code: "FLOOR_BLOCKED" });
    await expect(p1).resolves.toBeDefined();
    const err = await p2.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TunnelOpenError);
    expect((err as TunnelOpenError).mapping.status).toBe(403);
  });

  it("unknown OPEN_ERR codes map to DIAL_FAIL", async () => {
    const { mux, node } = setup();
    const p = mux.openStream("a.com", 443);
    node(FrameType.OPEN_ERR, 1, { code: "__proto__" });
    await expect(p).rejects.toMatchObject({ code: "DIAL_FAIL" });
  });

  it("rejects beyond maxStreams with CAP_EXCEEDED without sending OPEN", async () => {
    const { out, mux } = setup(65536, 1);
    void mux.openStream("a.com", 443).catch(() => undefined);
    await expect(mux.openStream("b.com", 443)).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
    expect(out).toHaveLength(1);
    mux.closeAll();
  });

  it("times out an unanswered OPEN and RSTs the id", async () => {
    const { out, mux } = setup();
    await expect(mux.openStream("a.com", 443)).rejects.toMatchObject({ code: "TIMEOUT" });
    const last = out[out.length - 1];
    expect(last.type).toBe(FrameType.CLOSE);
    expect(last.flags & FLAG_RST).toBeTruthy();
  });

  it("honours send credit and resumes on WINDOW", async () => {
    const { out, mux, node } = setup(65536);
    const p = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s = await p;
    let done = false;
    s.write(Buffer.alloc(100_000, 1), () => { done = true; });
    await tick();
    const sent = () => out.filter((f) => f.type === FrameType.DATA).reduce((n, f) => n + f.payload.length, 0);
    expect(sent()).toBe(65536);
    expect(done).toBe(false);
    const w = Buffer.alloc(4);
    w.writeUInt32BE(65536, 0);
    node(FrameType.WINDOW, 1, w);
    await tick();
    expect(sent()).toBe(100_000);
    expect(done).toBe(true);
  });

  it("grants WINDOW as the consumer reads and RSTs on window violation", async () => {
    const { out, mux, node, reports } = setup(65536);
    const p = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s = await p;
    const got: Buffer[] = [];
    s.on("data", (c: Buffer) => got.push(c));
    s.on("error", () => undefined);
    node(FrameType.DATA, 1, Buffer.alloc(40_000));
    await tick();
    const win = out.find((f) => f.type === FrameType.WINDOW);
    expect(win?.payload.readUInt32BE(0)).toBe(40_000);
    // Stop consuming: in flight allowed now is 40_000 granted + 65_536 window - 40_000 received.
    s.pause();
    node(FrameType.DATA, 1, Buffer.alloc(65_536));
    node(FrameType.DATA, 1, Buffer.alloc(1));
    await tick();
    expect(reports[0].reason).toBe("window_violation");
    expect(out.some((f) => f.type === FrameType.CLOSE && (f.flags & FLAG_RST) !== 0)).toBe(true);
  });

  it("records node CLOSE byte reports with gateway counts", async () => {
    const { mux, node, reports, out } = setup();
    const p = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s = await p;
    s.resume();
    s.write(Buffer.from("hello"));
    node(FrameType.DATA, 1, Buffer.from("world!"));
    await tick();
    const ended = new Promise((r) => s.on("end", r));
    node(FrameType.CLOSE, 1, { bytesIn: 5, bytesOut: 6, reason: "eof" }, FLAG_FIN);
    await ended;
    // Node FIN is a half-close: the stream is not reported until we finish too.
    expect(reports).toHaveLength(0);
    expect(out.filter((f) => f.type === FrameType.CLOSE)).toHaveLength(0);
    s.end();
    await tick();
    expect(reports[0]).toMatchObject({
      streamId: 1, host: "a.com", port: 443, gatewayBytesOut: 5, gatewayBytesIn: 6,
      nodeReport: { bytesIn: 5, bytesOut: 6, reason: "eof" },
    });
    // Our own FIN for the upstream direction, never a RST.
    expect(out.filter((f) => f.type === FrameType.CLOSE).map((f) => f.flags)).toEqual([FLAG_FIN]);
  });

  it("keeps the upstream direction writable after a node FIN (half-close)", async () => {
    const { mux, node, out } = setup();
    const p = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s = await p;
    s.resume();
    node(FrameType.CLOSE, 1, { bytesIn: 0, bytesOut: 0, reason: "eof" }, FLAG_FIN);
    await tick();
    const err = await new Promise<Error | null | undefined>((r) => s.write(Buffer.from("late upload"), r));
    expect(err).toBeFalsy();
    expect(out.some((f) => f.type === FrameType.DATA && f.streamId === 1 && f.payload.toString() === "late upload")).toBe(true);
  });

  it("resets a late OPEN_OK / DATA / WINDOW for an id it no longer tracks", async () => {
    const { mux, node, out } = setup();
    const p = mux.openStream("slow.com", 443);
    await expect(p).rejects.toBeInstanceOf(TunnelOpenError); // 200ms open timeout
    out.length = 0;
    node(FrameType.OPEN_OK, 1, {});
    node(FrameType.DATA, 1, Buffer.from("x"));
    const w = Buffer.alloc(4); w.writeUInt32BE(10, 0);
    node(FrameType.WINDOW, 1, w);
    const rsts = out.filter((f) => f.type === FrameType.CLOSE && f.streamId === 1 && (f.flags & FLAG_RST) !== 0);
    expect(rsts).toHaveLength(3);
  });

  it("sends CLOSE FIN on end() and RST on destroy()", async () => {
    const { mux, node, out } = setup();
    const p1 = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s1 = await p1;
    s1.end();
    await tick();
    expect(out.find((f) => f.type === FrameType.CLOSE && f.streamId === 1)?.flags).toBe(FLAG_FIN);
    const p2 = mux.openStream("b.com", 443);
    node(FrameType.OPEN_OK, 3, {});
    const s2 = await p2;
    s2.destroy();
    await tick();
    expect(out.find((f) => f.type === FrameType.CLOSE && f.streamId === 3)?.flags).toBe(FLAG_RST);
  });

  it("closeAll rejects pending opens and errors live streams", async () => {
    const { mux, node, reports } = setup();
    const p1 = mux.openStream("a.com", 443);
    node(FrameType.OPEN_OK, 1, {});
    const s = await p1;
    const errored = new Promise((r) => s.on("error", r));
    const p2 = mux.openStream("b.com", 443);
    mux.closeAll();
    await expect(p2).rejects.toBeInstanceOf(TunnelOpenError);
    await errored;
    expect(reports[0].reason).toBe("tunnel_closed");
  });

  it("rejects even stream ids as protocol errors", () => {
    const { node } = setup();
    expect(() => node(FrameType.OPEN_OK, 2, {})).toThrow();
  });
});
