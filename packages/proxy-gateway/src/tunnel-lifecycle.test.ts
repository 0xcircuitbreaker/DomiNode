import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { bindTunnelLifecycle } from "./tunnel-lifecycle.js";

const tick = () => new Promise((r) => setImmediate(r));

describe("bindTunnelLifecycle", () => {
  it("client half-close ends only the upstream write side; response still flows", async () => {
    // Real half-open TCP pair for the client side.
    const server = net.createServer({ allowHalfOpen: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const accepted = new Promise<net.Socket>((r) => server.once("connection", r));
    const requester = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    const clientSocket = await accepted;

    const upstreamWritten: Buffer[] = [];
    let upstreamFinished = false;
    const upstream = new Duplex({
      allowHalfOpen: true,
      read() { /* pushed below */ },
      write(c, _e, cb) { upstreamWritten.push(c); cb(); },
      final(cb) { upstreamFinished = true; cb(); },
    });
    const cleanup = vi.fn();
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    bindTunnelLifecycle(clientSocket, upstream, cleanup);
    const response: Buffer[] = [];
    requester.on("data", (c: Buffer) => response.push(c));

    requester.end("GET / HTTP/1.0\r\n\r\n"); // request then FIN
    await new Promise((r) => setTimeout(r, 30));
    expect(cleanup).not.toHaveBeenCalled();
    expect(upstreamFinished).toBe(true);
    expect(Buffer.concat(upstreamWritten).toString()).toContain("GET /");

    // Response arrives after the client's FIN and is still delivered.
    upstream.push(Buffer.from("HTTP/1.0 200 OK\r\n\r\nhi"));
    upstream.push(null);
    await new Promise((r) => requester.once("end", r));
    expect(Buffer.concat(response).toString()).toContain("hi");
    await new Promise((r) => setTimeout(r, 20));
    expect(cleanup).toHaveBeenCalled();
    requester.destroy();
    server.close();
  });

  it("tears down immediately on upstream reset", async () => {
    const client = new PassThrough();
    const upstream = new PassThrough();
    upstream.on("error", () => undefined);
    const cleanup = vi.fn();
    bindTunnelLifecycle(client, upstream, cleanup);
    upstream.destroy(new Error("reset"));
    await tick();
    expect(cleanup).toHaveBeenCalled();
  });

  it("tears down on client error/close", async () => {
    const client = new PassThrough();
    const upstream = new PassThrough();
    const cleanup = vi.fn();
    bindTunnelLifecycle(client, upstream, cleanup);
    client.destroy();
    await tick();
    expect(cleanup).toHaveBeenCalled();
  });
});
