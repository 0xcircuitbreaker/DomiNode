/**
 * Dominus Node Teams n8n community node.
 *
 * Operations (9 tools):
 * - Delete Team: Delete a team
 * - Revoke Team Key: Revoke a team API key
 * - List Team Keys: List all API keys for a team
 * - List Team Members: List all members of a team
 * - Add Team Member: Add a user to a team
 * - Remove Team Member: Remove a user from a team
 * - Invite Team Member: Send an email invitation to join a team
 * - List Team Invites: List pending invitations for a team
 * - Cancel Team Invite: Cancel a pending team invitation
 *
 * Security:
 * - UUID validation for team/user/key/invite IDs
 * - Email validation for invitations
 * - Control character rejection
 * - Credential sanitization in error messages
 *
 * @module
 */

import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";

import { DominusNodeAuth, sanitizeError } from "../../shared/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class DominusNodeTeams implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Teams",
    name: "dominusNodeTeams",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Manage Dominus Node team members, keys, and invitations",
    defaults: { name: "Dominus Node Teams" },
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
          { name: "Delete Team", value: "teamDelete", description: "Delete a team", action: "Delete team" },
          { name: "Revoke Team Key", value: "teamRevokeKey", description: "Revoke a team API key", action: "Revoke team key" },
          { name: "List Team Keys", value: "teamListKeys", description: "List all API keys for a team", action: "List team keys" },
          { name: "List Team Members", value: "teamListMembers", description: "List all members of a team", action: "List team members" },
          { name: "Add Team Member", value: "teamAddMember", description: "Add a user to a team", action: "Add team member" },
          { name: "Remove Team Member", value: "teamRemoveMember", description: "Remove a user from a team", action: "Remove team member" },
          { name: "Invite Team Member", value: "teamInviteMember", description: "Send an email invitation to join a team", action: "Invite team member" },
          { name: "List Team Invites", value: "teamListInvites", description: "List pending invitations for a team", action: "List team invites" },
          { name: "Cancel Team Invite", value: "teamCancelInvite", description: "Cancel a pending team invitation", action: "Cancel team invite" },
        ],
        default: "teamListMembers",
      },

      // --- Team ID (shared) ---
      {
        displayName: "Team ID",
        name: "teamId",
        type: "string",
        default: "",
        required: true,
        description: "Team UUID",
        displayOptions: {
          show: {
            operation: [
              "teamDelete",
              "teamRevokeKey",
              "teamListKeys",
              "teamListMembers",
              "teamAddMember",
              "teamRemoveMember",
              "teamInviteMember",
              "teamListInvites",
              "teamCancelInvite",
            ],
          },
        },
      },

      // --- Key ID for revoke ---
      {
        displayName: "Key ID",
        name: "keyId",
        type: "string",
        default: "",
        required: true,
        description: "UUID of the team API key to revoke",
        displayOptions: { show: { operation: ["teamRevokeKey"] } },
      },

      // --- User ID for add/remove member ---
      {
        displayName: "User ID",
        name: "userId",
        type: "string",
        default: "",
        required: true,
        description: "UUID of the user to add or remove",
        displayOptions: { show: { operation: ["teamAddMember", "teamRemoveMember"] } },
      },

      // --- Role for add member / invite ---
      {
        displayName: "Role",
        name: "role",
        type: "options",
        options: [
          { name: "Admin", value: "admin" },
          { name: "Member", value: "member" },
        ],
        default: "member",
        description: "Role for the team member",
        displayOptions: { show: { operation: ["teamAddMember", "teamInviteMember"] } },
      },

      // --- Invite email ---
      {
        displayName: "Email",
        name: "inviteEmail",
        type: "string",
        default: "",
        required: true,
        description: "Email address to send the invitation to",
        displayOptions: { show: { operation: ["teamInviteMember"] } },
      },

      // --- Invite ID for cancel ---
      {
        displayName: "Invite ID",
        name: "inviteId",
        type: "string",
        default: "",
        required: true,
        description: "UUID of the invitation to cancel",
        displayOptions: { show: { operation: ["teamCancelInvite"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("dominusNodeApi");

    const apiKey = credentials.apiKey as string;
    const baseUrl = (credentials.baseUrl as string) || "https://api.dominusnode.com";

    if (!apiKey) {
      throw new NodeOperationError(this.getNode(), "API Key is required");
    }

    const agentSecret = (credentials.agentSecret as string) || undefined;
    const auth = new DominusNodeAuth(apiKey, baseUrl, 30000, agentSecret);
    const operation = this.getNodeParameter("operation", 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let result: unknown;

        // All operations require teamId
        const teamId = this.getNodeParameter("teamId", i) as string;
        validateUuid(this, teamId, "teamId", i);

        switch (operation) {
          case "teamDelete": {
            result = await auth.apiRequest(
              "DELETE",
              `/api/teams/${encodeURIComponent(teamId)}`,
            );
            break;
          }

          case "teamRevokeKey": {
            const keyId = this.getNodeParameter("keyId", i) as string;
            validateUuid(this, keyId, "keyId", i);
            result = await auth.apiRequest(
              "DELETE",
              `/api/teams/${encodeURIComponent(teamId)}/keys/${encodeURIComponent(keyId)}`,
            );
            break;
          }

          case "teamListKeys": {
            result = await auth.apiRequest(
              "GET",
              `/api/teams/${encodeURIComponent(teamId)}/keys`,
            );
            break;
          }

          case "teamListMembers": {
            result = await auth.apiRequest(
              "GET",
              `/api/teams/${encodeURIComponent(teamId)}/members`,
            );
            break;
          }

          case "teamAddMember": {
            const userId = this.getNodeParameter("userId", i) as string;
            const role = this.getNodeParameter("role", i, "member") as string;
            validateUuid(this, userId, "userId", i);
            if (role !== "member" && role !== "admin") {
              throw new NodeOperationError(
                this.getNode(),
                "Role must be 'member' or 'admin'",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest(
              "POST",
              `/api/teams/${encodeURIComponent(teamId)}/members`,
              { userId, role },
            );
            break;
          }

          case "teamRemoveMember": {
            const userId = this.getNodeParameter("userId", i) as string;
            validateUuid(this, userId, "userId", i);
            result = await auth.apiRequest(
              "DELETE",
              `/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
            );
            break;
          }

          case "teamInviteMember": {
            const email = this.getNodeParameter("inviteEmail", i) as string;
            const role = this.getNodeParameter("role", i, "member") as string;
            const safeEmail = validateEmail(this, email, i);
            if (role !== "member" && role !== "admin") {
              throw new NodeOperationError(
                this.getNode(),
                "Role must be 'member' or 'admin'",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest(
              "POST",
              `/api/teams/${encodeURIComponent(teamId)}/invites`,
              { email: safeEmail, role },
            );
            break;
          }

          case "teamListInvites": {
            result = await auth.apiRequest(
              "GET",
              `/api/teams/${encodeURIComponent(teamId)}/invites`,
            );
            break;
          }

          case "teamCancelInvite": {
            const inviteId = this.getNodeParameter("inviteId", i) as string;
            validateUuid(this, inviteId, "inviteId", i);
            result = await auth.apiRequest(
              "DELETE",
              `/api/teams/${encodeURIComponent(teamId)}/invites/${encodeURIComponent(inviteId)}`,
            );
            break;
          }

          default:
            throw new NodeOperationError(
              this.getNode(),
              `Unknown operation: ${operation}`,
              { itemIndex: i },
            );
        }

        returnData.push({ json: (result ?? {}) as IDataObject });
      } catch (err) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: sanitizeError(err instanceof Error ? err.message : String(err)),
            },
          });
          continue;
        }
        if (err instanceof NodeOperationError) throw err;
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

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateUuid(
  ctx: IExecuteFunctions,
  value: string,
  fieldName: string,
  itemIndex: number,
): void {
  if (!value || typeof value !== "string") {
    throw new NodeOperationError(ctx.getNode(), `${fieldName} is required`, { itemIndex });
  }
  if (!UUID_RE.test(value)) {
    throw new NodeOperationError(ctx.getNode(), `${fieldName} must be a valid UUID`, { itemIndex });
  }
}

function validateEmail(
  ctx: IExecuteFunctions,
  email: string,
  itemIndex: number,
): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed || !EMAIL_RE.test(trimmed)) {
    throw new NodeOperationError(
      ctx.getNode(),
      "A valid email address is required",
      { itemIndex },
    );
  }
  if (trimmed.length > 254) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Email address too long (max 254 characters)",
      { itemIndex },
    );
  }
  return trimmed;
}
