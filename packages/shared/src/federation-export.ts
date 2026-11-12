/**
 * F6 helper for scripts/export-signed-policy.mjs: read the active policy from
 * the database with the standard entrypoint setup (connectWithRetry) and
 * always close the pool, even on failure. Errors are replaced with a fixed
 * message so connection strings or credentials never reach the console.
 */
import { connectWithRetry, closePool } from "./db.js";
import { getActivePolicy, type ActivePolicy } from "./repositories/policy-repo.js";

export interface PolicyExportDeps {
  connect: () => Promise<void>;
  getActivePolicy: () => Promise<ActivePolicy>;
  close: () => Promise<void>;
}

export class PolicyExportError extends Error {}

const defaultDeps: PolicyExportDeps = {
  connect: () => connectWithRetry(),
  getActivePolicy: () => getActivePolicy(),
  close: () => closePool(),
};

export async function readActivePolicyForExport(deps: PolicyExportDeps = defaultDeps): Promise<ActivePolicy> {
  try {
    await deps.connect();
    return await deps.getActivePolicy();
  } catch {
    throw new PolicyExportError("could not read the active policy from the database (check DATABASE_URL)");
  } finally {
    await deps.close().catch(() => {});
  }
}
