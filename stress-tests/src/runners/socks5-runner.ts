import net from "node:net";
import { getConfig } from "../config.js";

interface Socks5Result {
  success: boolean;
  latencyMs: number;
  bytesReceived: number;
  error?: string;
}

/**
 * Connect to target through SOCKS5 proxy, send HTTP GET, return response stats.
 */
async function socks5Request(
  proxyHost: string,
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  targetPath: string,
  apiKey: string,
  timeoutMs: number = 30_000,
): Promise<Socks5Result> {
  const start = Date.now();

  return new Promise<Socks5Result>((resolve) => {
    const socket = net.connect(proxyPort, proxyHost);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: 0, error: "timeout" });
    }, timeoutMs);

    socket.once("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: 0, error: err.message });
    });

    socket.once("connect", () => {
      // SOCKS5 greeting: version 5, 1 auth method (username/password = 0x02)
      socket.write(Buffer.from([0x05, 0x01, 0x02]));

      socket.once("data", (greeting) => {
        if (greeting[0] !== 0x05 || greeting[1] !== 0x02) {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: 0, error: "auth method rejected" });
          return;
        }

        // Send username/password auth (RFC 1929)
        const username = Buffer.from("stress");
        const password = Buffer.from(apiKey);
        const authBuf = Buffer.alloc(3 + username.length + password.length);
        authBuf[0] = 0x01; // version
        authBuf[1] = username.length;
        username.copy(authBuf, 2);
        authBuf[2 + username.length] = password.length;
        password.copy(authBuf, 3 + username.length);
        socket.write(authBuf);

        socket.once("data", (authResp) => {
          if (authResp[1] !== 0x00) {
            clearTimeout(timeout);
            socket.destroy();
            resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: 0, error: "auth failed" });
            return;
          }

          // Send CONNECT request
          const hostBuf = Buffer.from(targetHost);
          const connectBuf = Buffer.alloc(7 + hostBuf.length);
          connectBuf[0] = 0x05; // version
          connectBuf[1] = 0x01; // CONNECT
          connectBuf[2] = 0x00; // reserved
          connectBuf[3] = 0x03; // domain name
          connectBuf[4] = hostBuf.length;
          hostBuf.copy(connectBuf, 5);
          connectBuf.writeUInt16BE(targetPort, 5 + hostBuf.length);
          socket.write(connectBuf);

          socket.once("data", (connectResp) => {
            if (connectResp[1] !== 0x00) {
              clearTimeout(timeout);
              socket.destroy();
              resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: 0, error: `connect failed: ${connectResp[1]}` });
              return;
            }

            // Tunnel established -- send HTTP request
            const httpReq = `GET ${targetPath} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`;
            socket.write(httpReq);

            let totalBytes = 0;
            const chunks: Buffer[] = [];

            socket.on("data", (chunk: Buffer) => {
              totalBytes += chunk.length;
              chunks.push(chunk);
            });

            socket.on("end", () => {
              clearTimeout(timeout);
              const response = Buffer.concat(chunks).toString("utf-8", 0, Math.min(totalBytes, 1024));
              const statusMatch = response.match(/^HTTP\/\d\.\d (\d{3})/);
              const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

              resolve({
                success: statusCode >= 200 && statusCode < 400,
                latencyMs: Date.now() - start,
                bytesReceived: totalBytes,
                error: statusCode >= 400 ? `HTTP ${statusCode}` : undefined,
              });
            });

            socket.on("error", (err) => {
              clearTimeout(timeout);
              resolve({ success: false, latencyMs: Date.now() - start, bytesReceived: totalBytes, error: err.message });
            });
          });
        });
      });
    });
  });
}

export interface Socks5RunResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalBytesReceived: number;
  errors: Record<string, number>;
}

/**
 * Run concurrent SOCKS5 requests.
 */
export async function runSocks5Test(
  concurrency: number,
  totalRequests: number,
  apiKeys: string[],
  targetPath: string = "/payload/1kb",
): Promise<Socks5RunResult> {
  const config = getConfig();
  const results: Socks5Result[] = [];
  const errors: Record<string, number> = {};
  let nextIdx = 0;

  const targetHost = new URL(config.targetBaseUrl).hostname;
  const targetPort = parseInt(new URL(config.targetBaseUrl).port, 10) || 80;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= totalRequests) break;

      const apiKey = apiKeys[idx % apiKeys.length];
      const result = await socks5Request(
        config.proxyHost,
        config.proxySocks5Port,
        targetHost,
        targetPort,
        targetPath,
        apiKey,
      );

      results.push(result);

      if (result.error) {
        errors[result.error] = (errors[result.error] ?? 0) + 1;
      }
    }
  }

  // Launch concurrent workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Compute stats
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successful = results.filter((r) => r.success).length;

  return {
    totalRequests: results.length,
    successfulRequests: successful,
    failedRequests: results.length - successful,
    avgLatencyMs: latencies.reduce((s, l) => s + l, 0) / latencies.length,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
    p99LatencyMs: latencies[Math.floor(latencies.length * 0.99)] ?? 0,
    totalBytesReceived: results.reduce((s, r) => s + r.bytesReceived, 0),
    errors,
  };
}
