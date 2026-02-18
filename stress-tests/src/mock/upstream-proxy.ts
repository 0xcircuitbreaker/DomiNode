import http from "node:http";
import net from "node:net";

/**
 * Mock upstream proxy that simulates Webshare gateway.
 * Accepts any Proxy-Authorization, forwards HTTP requests and CONNECT tunnels
 * to the target server (mock-target or real destination).
 */

const PORT = parseInt(process.env.PORT ?? "31112", 10);
const TARGET_HOST = process.env.TARGET_HOST ?? "localhost";
const TARGET_PORT = parseInt(process.env.TARGET_PORT ?? "9090", 10);

let totalRequests = 0;
let totalConnects = 0;
let totalBytesForwarded = 0;

// HTTP forward proxy handler
const server = http.createServer((clientReq, clientRes) => {
  totalRequests++;

  // Parse the target URL from the request
  let targetUrl: URL;
  try {
    targetUrl = new URL(clientReq.url ?? "/");
  } catch {
    clientRes.writeHead(400, { "Content-Type": "text/plain" });
    clientRes.end("Bad Request: invalid URL");
    return;
  }

  // Health check (non-proxy direct request)
  if (clientReq.url === "/health") {
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(
      JSON.stringify({
        status: "ok",
        service: "mock-upstream-proxy",
        stats: { requests: totalRequests, connects: totalConnects, bytesForwarded: totalBytesForwarded },
      }),
    );
    return;
  }

  // Always forward to the configured target (mock-target), ignoring the requested hostname.
  // This lets the proxy's SSRF validator see public hostnames while we intercept the traffic.
  const FORCE_TARGET = process.env.FORCE_TARGET === "1";
  const targetHost = FORCE_TARGET ? TARGET_HOST : (targetUrl.hostname || TARGET_HOST);
  const targetPort = FORCE_TARGET ? TARGET_PORT : (parseInt(targetUrl.port, 10) || (targetUrl.protocol === "https:" ? 443 : TARGET_PORT));

  // Strip proxy headers, forward to target
  const headers: Record<string, string | string[] | undefined> = { ...clientReq.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  headers.host = targetUrl.host;

  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetUrl.pathname + targetUrl.search,
      method: clientReq.method,
      headers,
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.on("data", (chunk: Buffer) => {
        totalBytesForwarded += chunk.length;
      });
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", (err) => {
    clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end(`Bad Gateway: ${err.message}`);
  });

  clientReq.pipe(proxyReq);
});

// CONNECT tunnel handler (for HTTPS)
server.on("connect", (req, clientSocket, head) => {
  totalConnects++;

  const [hostname, portStr] = (req.url ?? "").split(":");
  const FORCE_TARGET = process.env.FORCE_TARGET === "1";
  const targetHost = FORCE_TARGET ? TARGET_HOST : (hostname || TARGET_HOST);
  const targetPort = FORCE_TARGET ? TARGET_PORT : (parseInt(portStr, 10) || TARGET_PORT);

  const serverSocket = net.connect(targetPort, targetHost, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (head.length > 0) {
      serverSocket.write(head);
    }

    serverSocket.on("data", (chunk: Buffer) => {
      totalBytesForwarded += chunk.length;
    });
    clientSocket.on("data", (chunk: Buffer) => {
      totalBytesForwarded += chunk.length;
    });

    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);

    serverSocket.on("error", () => {
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      serverSocket.destroy();
    });
  });

  serverSocket.on("error", (err) => {
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`);
    clientSocket.end();
  });

  clientSocket.on("error", () => {
    serverSocket.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`Mock upstream proxy listening on :${PORT}`);
  console.log(`Forwarding to ${TARGET_HOST}:${TARGET_PORT}`);
});
