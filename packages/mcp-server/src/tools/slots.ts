import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

interface SlotsInfoResponse {
  total: number;
  used: number;
  remaining: number;
  unlimited: boolean;
}

interface WaitlistJoinResponse {
  message: string;
}

interface WaitlistCountResponse {
  pending: number;
}

export function registerSlotsTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_check_slots",
    "Check how many alpha registration slots are available. Returns total, used, and remaining slot counts. No authentication required.",
    {},
    async () => {
      try {
        const data = await httpClient.get<SlotsInfoResponse>("/api/slots", false);
        if (data.unlimited) {
          return {
            content: [{ type: "text", text: "Registration is currently unlimited — no slot cap in effect." }],
          };
        }
        const text = [
          `Alpha Slot Availability`,
          `  Total slots: ${data.total}`,
          `  Used: ${data.used}`,
          `  Remaining: ${data.remaining}`,
          ``,
          data.remaining > 0
            ? `Slots available! Use dominusnode_setup or dominusnode_register to create an account.`
            : `All slots are taken. Use dominusnode_join_waitlist to get notified when a slot opens.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error checking slots: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_join_waitlist",
    "Join the waitlist to be notified when an alpha registration slot opens. No authentication required.",
    {
      email: z.string().email().describe("Email address to be notified at"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<WaitlistJoinResponse>(
          "/api/waitlist/join",
          { email: args.email },
          false,
        );
        return {
          content: [{ type: "text", text: data.message || "You've been added to the waitlist. We'll email you when a slot opens." }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Waitlist error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_get_waitlist_count",
    "Get the number of people currently on the waitlist. No authentication required.",
    {},
    async () => {
      try {
        const data = await httpClient.get<WaitlistCountResponse>("/api/waitlist/count", false);
        return {
          content: [{ type: "text", text: `Waitlist: ${data.pending} people waiting for an alpha slot.` }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
