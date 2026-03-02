/**
 * Dominus Node Usage n8n community node.
 *
 * Operations:
 * - Check Usage: Get proxy usage statistics for a given period
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

import { DominusNodeAuth, sanitizeError, periodToDateRange } from "../../shared/auth";

const VALID_PERIODS = new Set(["day", "week", "month"]);

export class DominusNodeUsage implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Usage",
    name: "dominusNodeUsage",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Check Dominus Node proxy usage statistics",
    defaults: { name: "Dominus Node Usage" },
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
            name: "Check Usage",
            value: "checkUsage",
            description: "Get proxy usage statistics for a given period",
            action: "Check usage",
          },
        ],
        default: "checkUsage",
      },
      {
        displayName: "Period",
        name: "period",
        type: "options",
        options: [
          { name: "Day", value: "day" },
          { name: "Week", value: "week" },
          { name: "Month", value: "month" },
        ],
        default: "month",
        description: "Time period for usage statistics",
        displayOptions: { show: { operation: ["checkUsage"] } },
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

    const auth = new DominusNodeAuth(apiKey, baseUrl);

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter("operation", i) as string;

        if (operation === "checkUsage") {
          const period = this.getNodeParameter("period", i, "month") as string;

          if (!VALID_PERIODS.has(period)) {
            throw new NodeOperationError(
              this.getNode(),
              `Invalid period '${period}'. Must be one of: day, week, month`,
              { itemIndex: i },
            );
          }

          // Backend expects since/until ISO dates, NOT a days integer
          const { since, until } = periodToDateRange(period);
          const params = new URLSearchParams({ since, until });
          const result = await auth.apiRequest("GET", `/api/usage?${params.toString()}`);

          returnData.push({ json: (result ?? {}) as IDataObject });
        } else {
          throw new NodeOperationError(
            this.getNode(),
            `Unknown operation: ${operation}`,
            { itemIndex: i },
          );
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
