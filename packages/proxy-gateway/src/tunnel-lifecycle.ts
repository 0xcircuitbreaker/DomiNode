import type { Duplex } from "node:stream";

/** Client sockets whose half-close is handled by bindTunnelLifecycle. */
const tunnelClients = new WeakSet<object>();

export function isTunnelClient(socket: object): boolean {
  return tunnelClients.has(socket);
}

/**
 * Wire close handling for a piped client <-> relay tunnel with TCP half-close
 * semantics. A client FIN only ends the upstream write side (the response can
 * still flow back); the tunnel is torn down on error/close, or once both
 * directions have finished and the client side has flushed.
 *
 * The client socket must be allowHalfOpen (http.Server sockets are; the
 * SOCKS5 server is created with allowHalfOpen: true).
 */
export function bindTunnelLifecycle(client: Duplex, upstream: Duplex, cleanup: () => void): void {
  tunnelClients.add(client);
  let clientEnded = false;
  let upstreamEnded = false;

  // Graceful completion: let our last bytes reach the client before destroy.
  const finishThenCleanup = (): void => {
    if (client.destroyed || client.writableFinished) cleanup();
    else client.once("finish", cleanup);
  };

  client.on("end", () => {
    clientEnded = true;
    if (!upstream.destroyed && !upstream.writableEnded) upstream.end();
    if (upstreamEnded) finishThenCleanup();
  });
  upstream.on("end", () => {
    upstreamEnded = true;
    if (!client.destroyed && !client.writableEnded) client.end();
    if (clientEnded) finishThenCleanup();
  });

  client.on("error", cleanup);
  client.on("close", cleanup);
  upstream.on("error", cleanup);
  upstream.on("close", () => {
    // A cleanly ended upstream (FIN both ways) closes before the client has
    // flushed; anything else (RST, tunnel drop) tears down now.
    if (upstreamEnded) finishThenCleanup();
    else cleanup();
  });
}
