/**
 * Dominus Node Proxy n8n community node.
 *
 * Operations (4 tools):
 * - Proxied Fetch: Make HTTP requests through Dominus Node's rotating proxy network
 * - Get Proxy Config: Retrieve proxy endpoint configuration
 * - List Active Sessions: List currently active proxy sessions
 * - Get Proxy Status: Get proxy pool health and availability status
 *
 * Security:
 * - Full SSRF prevention (private IPs, hex/octal/decimal, IPv6 variants,
 *   Teredo, 6to4, CGNAT, multicast, .localhost/.local/.internal/.arpa)
 * - DNS rebinding protection
 * - OFAC sanctioned country blocking
 * - Read-only HTTP methods only (GET, HEAD, OPTIONS)
 * - Credential sanitization in error messages
 * - Prototype pollution prevention
 *
 * @module
 */

import * as http from "node:http";
import * as tls from "node:tls";
import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";

import { validateUrl } from "../../shared/ssrf";
import {
  DominusNodeAuth,
  sanitizeError,
  checkDnsRebinding,
  SANCTIONED_COUNTRIES,
} from "../../shared/auth";
import { ALLOWED_METHODS, MAX_BODY_TRUNCATE } from "../../shared/constants";

const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "authorization",
  "user-agent",
]);

export class DominusNodeProxy implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Proxy",
    name: "dominusNodeProxy",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Make requests through Dominus Node rotating proxy network",
    defaults: { name: "Dominus Node Proxy" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "dominusNodeApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Proxied Fetch",
            value: "proxiedFetch",
            description: "Make an HTTP request through the proxy network",
            action: "Proxied fetch",
          },
          {
            name: "Get Proxy Config",
            value: "getProxyConfig",
            description: "Get proxy endpoint configuration",
            action: "Get proxy config",
          },
          {
            name: "List Active Sessions",
            value: "listActiveSessions",
            description: "List currently active proxy sessions",
            action: "List active sessions",
          },
          {
            name: "Get Proxy Status",
            value: "getProxyStatus",
            description: "Get proxy pool health and availability status",
            action: "Get proxy status",
          },
        ],
        default: "proxiedFetch",
      },
      // Proxied Fetch parameters
      {
        displayName: "URL",
        name: "url",
        type: "string",
        default: "",
        required: true,
        description: "The URL to fetch through the proxy",
        displayOptions: { show: { operation: ["proxiedFetch"] } },
      },
      {
        displayName: "Method",
        name: "method",
        type: "options",
        options: [
          { name: "GET", value: "GET" },
          { name: "HEAD", value: "HEAD" },
          { name: "OPTIONS", value: "OPTIONS" },
        ],
        default: "GET",
        description: "HTTP method (only read-only methods allowed)",
        displayOptions: { show: { operation: ["proxiedFetch"] } },
      },
      {
        displayName: "Proxy Type",
        name: "proxyType",
        type: "options",
        options: [
          { name: "Datacenter ($3/GB)", value: "dc" },
          { name: "Residential ($5/GB)", value: "residential" },
          { name: "Auto", value: "auto" },
        ],
        default: "dc",
        description: "Type of proxy IP to use",
        displayOptions: { show: { operation: ["proxiedFetch"] } },
      },
      {
        displayName: "Country",
        name: "country",
        type: "string",
        default: "",
        description: "Two-letter country code for geo-targeting (e.g., US, GB, DE). Leave empty for any.",
        displayOptions: { show: { operation: ["proxiedFetch"] } },
      },
      {
        displayName: "Custom Headers",
        name: "headers",
        type: "fixedCollection",
        typeOptions: { multipleValues: true },
        default: {},
        description: "Custom HTTP headers to include in the request",
        displayOptions: { show: { operation: ["proxiedFetch"] } },
        options: [
          {
            name: "header",
            displayName: "Header",
            values: [
              {
                displayName: "Name",
                name: "name",
                type: "string",
                default: "",
              },
              {
                displayName: "Value",
                name: "value",
                type: "string",
                default: "",
              },
            ],
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("dominusNodeApi");

    const apiKey = credentials.apiKey as string;
    const baseUrl = (credentials.baseUrl as string) || "https://api.dominusnode.com";
    const proxyHost = (credentials.proxyHost as string) || "proxy.dominusnode.com";
    const proxyPort = Number(credentials.proxyPort) || 8080;

    if (!apiKey) {
      throw new NodeOperationError(this.getNode(), "API Key is required");
    }

    const agentSecret = (credentials.agentSecret as string) || undefined;
    const auth = new DominusNodeAuth(apiKey, baseUrl, 30000, agentSecret);
    const operation = this.getNodeParameter("operation", 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        if (operation === "proxiedFetch") {
          const url = this.getNodeParameter("url", i) as string;
          const method = this.getNodeParameter("method", i, "GET") as string;
          const proxyType = this.getNodeParameter("proxyType", i, "dc") as string;
          const country = this.getNodeParameter("country", i, "") as string;
          const headersParam = this.getNodeParameter("headers", i, {}) as {
            header?: Array<{ name: string; value: string }>;
          };

          // Validate URL (SSRF prevention)
          if (!url || typeof url !== "string") {
            throw new NodeOperationError(this.getNode(), "URL is required", { itemIndex: i });
          }

          let parsedUrl: URL;
          try {
            parsedUrl = validateUrl(url);
          } catch (err) {
            throw new NodeOperationError(
              this.getNode(),
              err instanceof Error ? err.message : "URL validation failed",
              { itemIndex: i },
            );
          }

          // DNS rebinding protection
          try {
            await checkDnsRebinding(parsedUrl.hostname);
          } catch (err) {
            throw new NodeOperationError(
              this.getNode(),
              err instanceof Error ? err.message : "DNS validation failed",
              { itemIndex: i },
            );
          }

          // Validate method
          const upperMethod = method.toUpperCase();
          if (!ALLOWED_METHODS.has(upperMethod)) {
            throw new NodeOperationError(
              this.getNode(),
              `HTTP method '${upperMethod}' is not allowed. Only GET, HEAD, OPTIONS are permitted.`,
              { itemIndex: i },
            );
          }

          // OFAC sanctioned country check
          if (country) {
            const upper = country.toUpperCase();
            if (SANCTIONED_COUNTRIES.has(upper)) {
              throw new NodeOperationError(
                this.getNode(),
                `Country '${upper}' is blocked (OFAC sanctioned country)`,
                { itemIndex: i },
              );
            }
          }

          // Build proxy username for geo-targeting (uses hyphens, not underscores)
          const userParts: string[] = [];
          if (proxyType && proxyType !== "auto") userParts.push(proxyType);
          if (country) userParts.push(`country-${country.toUpperCase()}`);
          const username = userParts.length > 0 ? userParts.join("-") : "auto";
          const proxyAuth = "Basic " + Buffer.from(`${username}:${apiKey}`).toString("base64");

          // Build safe headers
          const safeHeaders: Record<string, string> = {};
          if (headersParam.header) {
            for (const { name, value } of headersParam.header) {
              if (!name) continue;
              if (BLOCKED_HEADERS.has(name.toLowerCase())) continue;
              // CRLF injection prevention
              if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue;
              safeHeaders[name] = value;
            }
          }

          // Route through proxy gateway
          const MAX_BODY_BYTES = 1_048_576; // 1MB response cap
          const result = await new Promise<{
            status: number;
            headers: Record<string, string>;
            body: string;
          }>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Proxy request timed out after 30000ms")),
              30_000,
            );

            if (parsedUrl.protocol === "https:") {
              // HTTPS: CONNECT tunnel + TLS
              const connectHost = parsedUrl.hostname.includes(":") ? `[${parsedUrl.hostname}]` : parsedUrl.hostname;
              const connectReq = http.request({
                hostname: proxyHost,
                port: proxyPort,
                method: "CONNECT",
                path: `${connectHost}:${parsedUrl.port || 443}`,
                headers: {
                  "Proxy-Authorization": proxyAuth,
                  Host: `${connectHost}:${parsedUrl.port || 443}`,
                },
              });

              connectReq.on("connect", (_res, tunnelSocket) => {
                if (_res.statusCode !== 200) {
                  clearTimeout(timeout);
                  tunnelSocket.destroy();
                  reject(new Error(`CONNECT failed: ${_res.statusCode}`));
                  return;
                }

                const tlsSocket = tls.connect(
                  {
                    host: parsedUrl.hostname,
                    socket: tunnelSocket,
                    servername: parsedUrl.hostname,
                    minVersion: "TLSv1.2",
                  },
                  () => {
                    const reqPath = parsedUrl.pathname + parsedUrl.search;
                    let reqLine = `${upperMethod} ${reqPath} HTTP/1.1\r\nHost: ${parsedUrl.host}\r\nUser-Agent: n8n-nodes-dominusnode/1.0.0\r\nAccept: */*\r\nConnection: close\r\n`;
                    for (const [k, v] of Object.entries(safeHeaders)) {
                      if (!["host", "user-agent", "connection"].includes(k.toLowerCase())) {
                        reqLine += `${k}: ${v}\r\n`;
                      }
                    }
                    reqLine += "\r\n";
                    tlsSocket.write(reqLine);

                    const chunks: Buffer[] = [];
                    let byteCount = 0;
                    tlsSocket.on("data", (chunk: Buffer) => {
                      byteCount += chunk.length;
                      if (byteCount <= MAX_BODY_BYTES + 16384) chunks.push(chunk);
                    });

                    let finalized = false;
                    const finalize = () => {
                      if (finalized) return;
                      finalized = true;
                      clearTimeout(timeout);
                      const raw = Buffer.concat(chunks).toString("utf-8");
                      const headerEnd = raw.indexOf("\r\n\r\n");
                      if (headerEnd === -1) {
                        reject(new Error("Malformed response"));
                        return;
                      }
                      const headerSection = raw.substring(0, headerEnd);
                      const body = raw.substring(headerEnd + 4).substring(0, MAX_BODY_BYTES);
                      const statusLine = headerSection.split("\r\n")[0];
                      const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
                      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
                      const respHeaders: Record<string, string> = {};
                      for (const line of headerSection.split("\r\n").slice(1)) {
                        const ci = line.indexOf(":");
                        if (ci > 0) {
                          respHeaders[line.substring(0, ci).trim().toLowerCase()] =
                            line.substring(ci + 1).trim();
                        }
                      }
                      resolve({ status, headers: respHeaders, body });
                    };

                    tlsSocket.on("end", finalize);
                    tlsSocket.on("close", finalize);
                    tlsSocket.on("error", (err) => {
                      clearTimeout(timeout);
                      reject(err);
                    });
                  },
                );

                tlsSocket.on("error", (err) => {
                  clearTimeout(timeout);
                  reject(err);
                });
              });

              connectReq.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
              });
              connectReq.end();
            } else {
              // HTTP: direct proxy request (full-URL path)
              const req = http.request(
                {
                  hostname: proxyHost,
                  port: proxyPort,
                  method: upperMethod,
                  path: url,
                  headers: {
                    ...safeHeaders,
                    "Proxy-Authorization": proxyAuth,
                    Host: parsedUrl.host,
                  },
                },
                (res) => {
                  const chunks: Buffer[] = [];
                  let byteCount = 0;
                  res.on("data", (chunk: Buffer) => {
                    byteCount += chunk.length;
                    if (byteCount <= MAX_BODY_BYTES) chunks.push(chunk);
                  });

                  let finalized = false;
                  const finalize = () => {
                    if (finalized) return;
                    finalized = true;
                    clearTimeout(timeout);
                    const body = Buffer.concat(chunks).toString("utf-8").substring(0, MAX_BODY_BYTES);
                    const respHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) {
                      if (v) respHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
                    }
                    resolve({ status: res.statusCode ?? 0, headers: respHeaders, body });
                  };

                  res.on("end", finalize);
                  res.on("close", finalize);
                  res.on("error", (err) => {
                    clearTimeout(timeout);
                    reject(err);
                  });
                },
              );

              req.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
              });
              req.end();
            }
          });

          returnData.push({
            json: {
              status: result.status,
              headers: result.headers,
              body: result.body.substring(0, MAX_BODY_TRUNCATE),
              url,
              method: upperMethod,
              proxyType,
              country: country || undefined,
            },
          });
        } else if (operation === "getProxyConfig") {
          const result = await auth.apiRequest("GET", "/api/proxy/config");
          returnData.push({ json: result as IDataObject });
        } else if (operation === "listActiveSessions") {
          const result = await auth.apiRequest("GET", "/api/sessions/active");
          returnData.push({ json: result as IDataObject });
        } else if (operation === "getProxyStatus") {
          const result = await auth.apiRequest("GET", "/api/proxy/status");
          returnData.push({ json: result as IDataObject });
        }
      } catch (err) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: sanitizeError(err instanceof Error ? err.message : String(err)),
            },
          });
          continue;
        }
        throw new NodeOperationError(
          this.getNode(),
          sanitizeError(err instanceof Error ? err.message : String(err)),
          { itemIndex: i },
        );
      }
    }

    return [returnData];
  }
}
