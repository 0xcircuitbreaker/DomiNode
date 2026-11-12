import { getProxyPorts, assertDistinctProxyPorts } from "@dominusnode/shared";

/**
 * Fail-fast startup validation for the gateway. Returns every problem at once
 * so an operator fixes them in one pass; main() throws if the list is non-empty.
 */
export function checkGatewayEnv(env: NodeJS.ProcessEnv): string[] {
  const errors: string[] = [];
  if (!env["DATABASE_URL"]) errors.push("DATABASE_URL is required");
  if (env["NODE_ENV"] === "production" && !(env["COORD_SIGNING_KEY_FILE"] ?? "").trim()) {
    errors.push("COORD_SIGNING_KEY_FILE is required in production (see docs/agent-network/DEPLOYMENT.md §1)");
  }
  try {
    assertDistinctProxyPorts(getProxyPorts(env));
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return errors;
}
