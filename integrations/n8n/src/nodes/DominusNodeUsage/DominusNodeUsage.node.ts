/**
 * Dominus Node Usage n8n community node.
 *
 * Operations (3 tools):
 * - Check Usage: Get proxy usage statistics for a given period
 * - Get Daily Usage: Get daily usage breakdown for the last N days
 * - Get Top Hosts: Get top accessed hosts by bandwidth
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
          {
            name: "Get Daily Usage",
            value: "getDailyUsage",
            description: "Get daily usage breakdown for the last N days",
            action: "Get daily usage",
          },
          {
            name: "Get Top Hosts",
            value: "getTopHosts",
            description: "Get top accessed hosts by bandwidth",
            action: "Get top hosts",
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
      {
        displayName: "Days",
        name: "days",
        type: "number",
        default: 7,
        description: "Number of days of daily usage to return (1-365)",
        displayOptions: { show: { operation: ["getDailyUsage"] } },
      },
      {
        displayName: "Limit",
        name: "topHostsLimit",
        type: "number",
        default: 10,
        description: "Number of top hosts to return (1-100)",
        displayOptions: { show: { operation: ["getTopHosts"] } },
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
        } else if (operation === "getDailyUsage") {
          const days = this.getNodeParameter("days", i, 7) as number;
          if (!Number.isInteger(days) || days < 1 || days > 365) {
            throw new NodeOperationError(
              this.getNode(),
              "Days must be an integer between 1 and 365",
              { itemIndex: i },
            );
          }
          const result = await auth.apiRequest("GET", `/api/usage/daily?days=${days}`);
          returnData.push({ json: (result ?? {}) as IDataObject });
        } else if (operation === "getTopHosts") {
          const limit = this.getNodeParameter("topHostsLimit", i, 10) as number;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new NodeOperationError(
              this.getNode(),
              "Limit must be an integer between 1 and 100",
              { itemIndex: i },
            );
          }
          const result = await auth.apiRequest("GET", `/api/usage/top-hosts?limit=${limit}`);
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
