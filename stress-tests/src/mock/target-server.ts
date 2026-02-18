import http from "node:http";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PORT ?? "9090", 10);

// Pre-generate random buffers for payload responses
const CHUNK_SIZE = 65_536; // 64KB chunks
const RANDOM_CHUNK = crypto.randomBytes(CHUNK_SIZE);

function sendPayload(
  res: http.ServerResponse,
  sizeBytes: number,
  contentType = "application/octet-stream",
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(sizeBytes),
    "Cache-Control": "no-store",
  });

  let remaining = sizeBytes;
  function writeChunk(): void {
    while (remaining > 0) {
      const toWrite = Math.min(remaining, CHUNK_SIZE);
      const chunk = toWrite === CHUNK_SIZE ? RANDOM_CHUNK : RANDOM_CHUNK.subarray(0, toWrite);
      remaining -= toWrite;
      if (!res.write(chunk)) {
        res.once("drain", writeChunk);
        return;
      }
    }
    res.end();
  }
  writeChunk();
}

const PAYLOAD_MAP: Record<string, number> = {
  tiny: 10,
  "1kb": 1_024,
  "10kb": 10_240,
  "1mb": 1_048_576,
  "100mb": 104_857_600,
  "1gb": 1_073_741_824,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Health check
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mock-target" }));
    return;
  }

  // Payload endpoints: /payload/:size
  const payloadMatch = path.match(/^\/payload\/(.+)$/);
  if (payloadMatch) {
    const sizeName = payloadMatch[1];

    // Custom byte size: /payload/bytes/12345
    if (sizeName.startsWith("bytes/")) {
      const bytes = parseInt(sizeName.slice(6), 10);
      if (isNaN(bytes) || bytes < 0 || bytes > 2_147_483_647) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid byte size");
        return;
      }
      sendPayload(res, bytes);
      return;
    }

    const size = PAYLOAD_MAP[sizeName];
    if (size === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Unknown size: ${sizeName}. Available: ${Object.keys(PAYLOAD_MAP).join(", ")}`);
      return;
    }
    sendPayload(res, size);
    return;
  }

  // Echo endpoint (returns request info as JSON)
  if (path === "/echo") {
    const body: Buffer[] = [];
    req.on("error", () => { /* client disconnected */ });
    req.on("data", (chunk: Buffer) => body.push(chunk));
    req.on("end", () => {
      const response = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyLength: Buffer.concat(body).length,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
    return;
  }

  // IP endpoint (simulates httpbin.org/ip)
  if (path === "/ip") {
    const origin = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ origin }));
    return;
  }

  // Delay endpoint: /delay/:seconds
  const delayMatch = path.match(/^\/delay\/(\d+)$/);
  if (delayMatch) {
    const seconds = Math.min(parseInt(delayMatch[1], 10), 30);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ delay: seconds }));
    }, seconds * 1000);
    return;
  }

  // Status endpoint: /status/:code
  const statusMatch = path.match(/^\/status\/(\d{3})$/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(`Status ${code}`);
    return;
  }

  // Default: 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Mock target server listening on :${PORT}`);
  console.log(`Endpoints: /health, /ip, /echo, /payload/{tiny,1kb,10kb,1mb,100mb,1gb}, /delay/:s, /status/:code`);
});
