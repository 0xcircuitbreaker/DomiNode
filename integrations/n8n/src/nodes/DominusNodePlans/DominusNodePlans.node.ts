/**
 * Dominus Node Plans n8n community node.
 *
 * Operations (3 tools):
 * - Get Plan: Get current user plan
 * - List Plans: List all available plans
 * - Change Plan: Switch to a different plan
 *
 * Security:
 * - UUID validation for plan IDs
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

export class DominusNodePlans implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Plans",
    name: "dominusNodePlans",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Manage Dominus Node subscription plans",
    defaults: { name: "Dominus Node Plans" },
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
          { name: "Get Plan", value: "getPlan", description: "Get current user plan", action: "Get plan" },
          { name: "List Plans", value: "listPlans", description: "List all available plans", action: "List plans" },
          { name: "Change Plan", value: "changePlan", description: "Switch to a different plan", action: "Change plan" },
        ],
        default: "getPlan",
      },

      // --- Change Plan ---
      {
        displayName: "Plan ID",
        name: "planId",
        type: "string",
        default: "",
        required: true,
        description: "UUID of the plan to switch to",
        displayOptions: { show: { operation: ["changePlan"] } },
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
          case "getPlan": {
            result = await auth.apiRequest("GET", "/api/plans/user/plan");
            break;
          }

          case "listPlans": {
            result = await auth.apiRequest("GET", "/api/plans");
            break;
          }

          case "changePlan": {
            const planId = this.getNodeParameter("planId", i) as string;
            validateUuid(this, planId, "planId", i);
            result = await auth.apiRequest("PUT", "/api/plans/user/plan", { planId });
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
