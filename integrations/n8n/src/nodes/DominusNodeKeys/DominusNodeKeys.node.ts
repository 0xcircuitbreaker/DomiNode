/**
 * Dominus Node Keys n8n community node.
 *
 * Operations (3 tools):
 * - List Keys: List all API keys
 * - Create Key: Create a new API key
 * - Revoke Key: Revoke an existing API key
 *
 * Security:
 * - UUID validation for key IDs
 * - Control character rejection in labels
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
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export class DominusNodeKeys implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Keys",
    name: "dominusNodeKeys",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Manage Dominus Node API keys",
    defaults: { name: "Dominus Node Keys" },
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
          { name: "List Keys", value: "listKeys", description: "List all API keys", action: "List keys" },
          { name: "Create Key", value: "createKey", description: "Create a new API key", action: "Create key" },
          { name: "Revoke Key", value: "revokeKey", description: "Revoke an existing API key", action: "Revoke key" },
        ],
        default: "listKeys",
      },

      // --- Create Key ---
      {
        displayName: "Label",
        name: "keyLabel",
        type: "string",
        default: "",
        required: true,
        description: "Label for the new API key (max 100 chars)",
        displayOptions: { show: { operation: ["createKey"] } },
      },

      // --- Revoke Key ---
      {
        displayName: "Key ID",
        name: "keyId",
        type: "string",
        default: "",
        required: true,
        description: "UUID of the API key to revoke",
        displayOptions: { show: { operation: ["revokeKey"] } },
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

        switch (operation) {
          case "listKeys": {
            result = await auth.apiRequest("GET", "/api/keys");
            break;
          }

          case "createKey": {
            const label = this.getNodeParameter("keyLabel", i) as string;
            if (!label || typeof label !== "string" || label.length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "Key label is required",
                { itemIndex: i },
              );
            }
            if (label.length > 100) {
              throw new NodeOperationError(
                this.getNode(),
                "Key label must be 100 characters or fewer",
                { itemIndex: i },
              );
            }
            if (CONTROL_CHAR_RE.test(label)) {
              throw new NodeOperationError(
                this.getNode(),
                "Key label contains invalid control characters",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest("POST", "/api/keys", { label });
            break;
          }

          case "revokeKey": {
            const keyId = this.getNodeParameter("keyId", i) as string;
            validateUuid(this, keyId, "keyId", i);
            result = await auth.apiRequest(
              "DELETE",
              `/api/keys/${encodeURIComponent(keyId)}`,
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
