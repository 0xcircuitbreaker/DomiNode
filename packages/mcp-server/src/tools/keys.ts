import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { ApiKey, ApiKeyCreated } from "../types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          (k) => `${k.prefix}... | Label: ${k.label || "(none)"} | Created: ${k.created_at} | Last used: ${k.last_used_at ?? "never"}`,
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
        const data = await httpClient.post<ApiKeyCreated>("/api/keys", { label: args.label });
        const text = [
          `New API key created!`,
          `Key: ${data.key}`,
          `ID: ${data.id}`,
          `Label: ${data.label}`,
          ``,
          `IMPORTANT: Save this key now — it will not be shown again.`,
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
      key_id: z.string().describe("UUID of the API key to revoke"),
    },
    async (args) => {
      try {
        if (!UUID_REGEX.test(args.key_id)) {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid key ID — must be a UUID" }],
          };
        }
        await httpClient.delete(`/api/keys/${args.key_id}`);
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
