import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { ApiKey, ApiKeyCreated } from "../types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEYS_RATE_MAX = 10;
const KEYS_RATE_WINDOW_MS = 60_000;
const keysTimestamps: number[] = [];

function checkKeysRateLimit(): boolean {
  const now = Date.now();
  while (keysTimestamps.length > 0 && now - keysTimestamps[0] > KEYS_RATE_WINDOW_MS) {
    keysTimestamps.shift();
  }
  if (keysTimestamps.length > 100) keysTimestamps.length = 100;
  if (keysTimestamps.length >= KEYS_RATE_MAX) return false;
  keysTimestamps.push(now);
  return true;
}

export function registerKeysTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_list_keys",
    "List all API keys on this account. Shows key prefix, label, and last used date.",
    {},
    async () => {
      try {
        const data = await httpClient.get<{ keys: ApiKey[] }>("/api/keys");
        const keys = data.keys ?? [];
        if (keys.length === 0) {
          return { content: [{ type: "text", text: "No API keys found." }] };
        }
        const lines = keys.map(
          (k) => `${k.prefix}... | Label: ${k.label || "(none)"} | Created: ${k.createdAt} | Revoked: ${k.revokedAt ?? "no"}`,
        );
        lines.unshift(`API Keys (${keys.length}):`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_create_key",
    "Create a new API key. The full key is shown only once — save it immediately. Use a descriptive label.",
    {
      label: z.string().min(1).max(100).describe("Descriptive label for the key (e.g. 'scraping-agent')"),
    },
    async (args) => {
      try {
        if (!checkKeysRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 10 key operations per minute. Please wait before retrying." }],
          };
        }

        const data = await httpClient.post<ApiKeyCreated>("/api/keys", { label: args.label });
        const text = [
          `New API key created!`,
          `Key: ${data.key}`,
          `ID: ${data.id}`,
          `Label: ${data.label}`,
          ``,
          `IMPORTANT: Save this key now — it will not be shown again.`,
          `WARNING: This key is a secret credential. Do not log it, share it,`,
          `or include it in any output that may be visible to others.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_revoke_key",
    "Revoke an API key by ID. This immediately disables the key. Cannot be undone.",
    {
      key_id: z.string().regex(UUID_REGEX, "Invalid key ID — must be a UUID").describe("UUID of the API key to revoke"),
    },
    async (args) => {
      try {
        if (!checkKeysRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 10 key operations per minute. Please wait before retrying." }],
          };
        }

        await httpClient.delete(`/api/keys/${encodeURIComponent(args.key_id)}`);
        return { content: [{ type: "text", text: `API key ${args.key_id} has been revoked.` }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
