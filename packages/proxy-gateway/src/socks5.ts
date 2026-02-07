import * as net from "node:net";
import { createLogger, hashApiKey, userRepo } from "@dominode/shared";
import { buildUpstreamProxy } from "@dominode/pool-manager";
import { checkBalance } from "./balance-check.js";
import { attachByteCounters } from "./counting-stream.js";
import { startSession, endSession } from "./session-manager.js";
import type { ProxyOptions } from "./auth.js";
import { checkSanctionedCountry } from "./geo-check.js";
import { validateTarget, isValidHostname, isValidPort } from "./target-validator.js";
import { incrementUserConns, decrementUserConns } from "./connection-tracker.js";
import { checkAuthRateLimit, recordAuthFailure } from "./auth-rate-limit.js";

const log = createLogger("proxy:socks5");

// SOCKS5 constants
const SOCKS_VER = 0x05;
const AUTH_USERPASS = 0x02;
const AUTH_NONE_ACCEPTABLE = 0xff;
const USERPASS_VER = 0x01;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_COMMAND_NOT_SUPPORTED = 0x07;

function parseProxyOptions(username: string): ProxyOptions {
  const options: ProxyOptions = {};
  const countryMatch = username.match(/(?:^|-)country-([A-Za-z]{2})(?:-|$)/);
  if (countryMatch) options.country = countryMatch[1].toUpperCase();
  const sessionMatch = username.match(/(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/);
  if (sessionMatch) options.sessionId = sessionMatch[1];
  return options;
}

function sendReply(socket: net.Socket, rep: number): void {
  // Minimal SOCKS5 reply: VER REP RSV ATYP(IPv4) BND.ADDR(0.0.0.0) BND.PORT(0)
  const reply = Buffer.alloc(10);
  reply[0] = SOCKS_VER;
  reply[1] = rep;
  reply[2] = 0x00; // RSV
  reply[3] = ATYP_IPV4;
  // BND.ADDR and BND.PORT left as 0
  socket.write(reply);
}

async function handleSocks5Connection(clientSocket: net.Socket): Promise<void> {
  const clientIp = (clientSocket.remoteAddress ?? "").replace(/^::ffff:/, "");

  // Geo-check
  const blocked = checkSanctionedCountry(clientIp);
  if (blocked) {
    clientSocket.end();
    return;
  }

  // SOCKS5 auth rate limiting (Fix #7)
  if (checkAuthRateLimit(clientIp)) {
    clientSocket.end();
    return;
  }

  // Step 1: Read greeting (VER, NMETHODS, METHODS...)
  const greeting = await readBytes(clientSocket, 2, 5000);
  if (!greeting || greeting[0] !== SOCKS_VER) {
    clientSocket.end();
    return;
  }

  const nmethods = greeting[1];
  const methods = await readBytes(clientSocket, nmethods, 5000);
  if (!methods) {
    clientSocket.end();
    return;
  }

  // We require username/password auth (0x02)
  if (!Array.from(methods).includes(AUTH_USERPASS)) {
    clientSocket.write(Buffer.from([SOCKS_VER, AUTH_NONE_ACCEPTABLE]));
    clientSocket.end();
    return;
  }

  // Accept username/password auth
  clientSocket.write(Buffer.from([SOCKS_VER, AUTH_USERPASS]));

  // Step 2: Read username/password (RFC 1929)
  const authVer = await readBytes(clientSocket, 1, 5000);
  if (!authVer || authVer[0] !== USERPASS_VER) {
    clientSocket.end();
    return;
  }

  const ulenBuf = await readBytes(clientSocket, 1, 5000);
  if (!ulenBuf) { clientSocket.end(); return; }
  const ulen = ulenBuf[0];

  const unameBuf = await readBytes(clientSocket, ulen, 5000);
  if (!unameBuf) { clientSocket.end(); return; }
  const username = unameBuf.toString("utf-8");

  const plenBuf = await readBytes(clientSocket, 1, 5000);
  if (!plenBuf) { clientSocket.end(); return; }
  const plen = plenBuf[0];

  const passwdBuf = await readBytes(clientSocket, plen, 5000);
  if (!passwdBuf) { clientSocket.end(); return; }
  const apiKey = passwdBuf.toString("utf-8");

  // Authenticate
  if (!apiKey.startsWith("dn_live_")) {
    recordAuthFailure(clientIp);
    clientSocket.write(Buffer.from([USERPASS_VER, 0x01])); // auth failure
    clientSocket.end();
    return;
  }

  const keyHash = hashApiKey(apiKey);
  let userId: string;
  let proxyOptions: ProxyOptions;

  try {
    const result = await userRepo.findUserByApiKeyHash(keyHash);
    if (!result) {
      recordAuthFailure(clientIp);
      clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
      clientSocket.end();
      return;
    }
    userId = result.user.id;
    proxyOptions = parseProxyOptions(username);
  } catch (err) {
    log.error("SOCKS5 auth DB error", { error: err instanceof Error ? err.message : String(err) });
    clientSocket.write(Buffer.from([USERPASS_VER, 0x01]));
    clientSocket.end();
    return;
  }

  // Auth success
  clientSocket.write(Buffer.from([USERPASS_VER, 0x00]));

  // Per-user connection limit
  if (!incrementUserConns(userId)) {
    sendReply(clientSocket, REP_NOT_ALLOWED);
    clientSocket.end();
    return;
  }

  // Balance check
  const hasBalance = await checkBalance(userId);
  if (!hasBalance) {
    decrementUserConns(userId);
    sendReply(clientSocket, REP_NOT_ALLOWED);
    clientSocket.end();
    return;
  }

  // Step 3: Read request (VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT)
  const reqHeader = await readBytes(clientSocket, 4, 10000);
  if (!reqHeader || reqHeader[0] !== SOCKS_VER) {
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  const cmd = reqHeader[1];
  const atyp = reqHeader[3];

  if (cmd !== CMD_CONNECT) {
    sendReply(clientSocket, REP_COMMAND_NOT_SUPPORTED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Parse destination address
  let targetHost: string;
  if (atyp === ATYP_IPV4) {
    const addrBuf = await readBytes(clientSocket, 4, 5000);
    if (!addrBuf) { decrementUserConns(userId); clientSocket.end(); return; }
    targetHost = `${addrBuf[0]}.${addrBuf[1]}.${addrBuf[2]}.${addrBuf[3]}`;
  } else if (atyp === ATYP_DOMAIN) {
    const domLenBuf = await readBytes(clientSocket, 1, 5000);
    if (!domLenBuf) { decrementUserConns(userId); clientSocket.end(); return; }
    const domainBuf = await readBytes(clientSocket, domLenBuf[0], 5000);
    if (!domainBuf) { decrementUserConns(userId); clientSocket.end(); return; }
    targetHost = domainBuf.toString("utf-8");
  } else if (atyp === ATYP_IPV6) {
    const addrBuf = await readBytes(clientSocket, 16, 5000);
    if (!addrBuf) { decrementUserConns(userId); clientSocket.end(); return; }
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(addrBuf.readUInt16BE(i).toString(16));
    }
    targetHost = parts.join(":");
  } else {
    sendReply(clientSocket, REP_GENERAL_FAILURE);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  // Parse destination port
  const portBuf = await readBytes(clientSocket, 2, 5000);
  if (!portBuf) { decrementUserConns(userId); clientSocket.end(); return; }
  const targetPort = portBuf.readUInt16BE(0);

  // CRLF injection prevention + SSRF validation
  if (!isValidHostname(targetHost) || !isValidPort(targetPort)) {
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  const socksTargetCheck = await validateTarget(targetHost, targetPort);
  if (!socksTargetCheck.allowed) {
    sendReply(clientSocket, REP_NOT_ALLOWED);
    decrementUserConns(userId);
    clientSocket.end();
    return;
  }

  log.info("SOCKS5 CONNECT", { target: `${targetHost}:${targetPort}`, userId, country: proxyOptions.country });

  // Connect through PacketStream via HTTP CONNECT
  let upstream;
  try {
    upstream = buildUpstreamProxy(proxyOptions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sanctioned")) {
      sendReply(clientSocket, REP_NOT_ALLOWED);
      decrementUserConns(userId);
      clientSocket.end();
      return;
    }
    throw err;
  }

  const psSocket = net.connect(upstream.port, upstream.host, () => {
    psSocket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: Basic ${upstream.proxyAuth}\r\n` +
        `\r\n`,
    );
  });

  let tunnelEstablished = false;
  const headerChunks: Buffer[] = [];

  // Fix #6: Once-guard to prevent double-decrement
  let decremented = false;
  function safeDecrement(): void {
    if (!decremented) {
      decremented = true;
      decrementUserConns(userId);
    }
  }

  async function handleUpstreamData(chunk: Buffer): Promise<void> {
    if (tunnelEstablished) return;

    headerChunks.push(chunk);
    const fullBuffer = Buffer.concat(headerChunks);
    const headerStr = fullBuffer.toString("utf-8");

    if (!headerStr.includes("\r\n\r\n")) {
      psSocket.once("data", handleUpstreamData);
      return;
    }

    const statusLine = headerStr.split("\r\n")[0];

    if (!statusLine.includes("200")) {
      log.error("SOCKS5 PacketStream CONNECT failed", { status: statusLine });
      sendReply(clientSocket, REP_GENERAL_FAILURE);
      clientSocket.end();
      psSocket.destroy();
      safeDecrement();
      return;
    }

    tunnelEstablished = true;

    // Forward any remaining data after HTTP headers
    const headerEndIdx = fullBuffer.indexOf("\r\n\r\n") + 4;
    const remaining = fullBuffer.slice(headerEndIdx);

    // Set up byte counting BEFORE piping
    const counter = attachByteCounters(clientSocket, psSocket);

    // Fix #3: Start session BEFORE sending success reply (billing race condition fix)
    let sessionId: string;
    try {
      sessionId = await startSession(userId, targetHost, counter);
    } catch (err) {
      log.error("SOCKS5 failed to start session", { error: err instanceof Error ? err.message : String(err) });
      sendReply(clientSocket, REP_GENERAL_FAILURE);
      safeDecrement();
      clientSocket.end();
      psSocket.destroy();
      return;
    }

    // Session started successfully - NOW send success reply and start piping
    sendReply(clientSocket, REP_SUCCESS);

    if (remaining.length > 0) {
      clientSocket.write(remaining);
    }

    psSocket.pipe(clientSocket);
    clientSocket.pipe(psSocket);

    // Once-guard cleanup for session end
    const cleanup = () => {
      safeDecrement();
      endSession(sessionId).catch((cleanupErr) => {
        log.error("SOCKS5 session end failed", { sessionId, error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
      });
    };

    clientSocket.on("end", cleanup);
    clientSocket.on("error", cleanup);
    psSocket.on("end", cleanup);
    psSocket.on("error", cleanup);
  }

  psSocket.once("data", handleUpstreamData);

  psSocket.on("error", (err) => {
    log.error("SOCKS5 PacketStream error", { error: err.message });
    if (!tunnelEstablished) {
      sendReply(clientSocket, REP_GENERAL_FAILURE);
    }
    safeDecrement();
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    log.error("SOCKS5 client error", { error: err.message });
    psSocket.destroy();
  });

  // Handshake timeout
  const handshakeTimeout = setTimeout(() => {
    if (!tunnelEstablished) {
      log.error("SOCKS5 PacketStream handshake timeout");
      sendReply(clientSocket, REP_GENERAL_FAILURE);
      clientSocket.end();
      psSocket.destroy();
      safeDecrement();
    }
  }, 30_000);

  psSocket.once("close", () => clearTimeout(handshakeTimeout));
  clientSocket.once("close", () => clearTimeout(handshakeTimeout));
}

/**
 * Read exactly `n` bytes from a socket with a timeout.
 */
function readBytes(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer | null> {
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
        // Push excess back
        if (collected.length > n) {
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

export function startSocks5Server(port: number = 1080): net.Server {
  const server = net.createServer((socket) => {
    handleSocks5Connection(socket).catch((err) => {
      log.error("unhandled SOCKS5 error", { error: err instanceof Error ? err.message : String(err) });
      socket.destroy();
    });
  });

  server.maxConnections = parseInt(process.env["PROXY_MAX_CONNECTIONS"] ?? "5000", 10);

  server.listen(port, () => {
    log.info(`SOCKS5 proxy listening on port ${port}`);
  });

  return server;
}
