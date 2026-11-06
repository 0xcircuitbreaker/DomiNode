/**
 * DominusNode plugin for OpenClaw: registers the 19 standard v2 tools.
 *
 * Auth: the SDK's connectWithKey() exchanges DOMINUSNODE_API_KEY for a JWT pair via
 * POST /api/auth/verify-key and sends `Authorization: Bearer <JWT>` on /api routes
 * (and the raw key as Bearer on /v1 agent routes). No x-api-key header is used.
 *
 * The default export follows the definePluginEntry({ id, name, description, register(api) })
 * shape; it is a plain object so the plugin has no runtime dependency on openclaw.
 */
import { ClientProvider, createToolSpecs, runTool, type DominusNodeToolsConfig, type JsonSchemaObject, type StandardToolName } from "./core.js";

export {
  ClientProvider,
  createToolSpecs,
  runTool,
  safeError,
  scrubDeep,
  STANDARD_TOOL_NAMES,
  NODE_SETUP_GUIDE,
} from "./core.js";
export type { DominusNodeToolsConfig, DominusNodeToolSpec, StandardToolName, JsonSchemaObject } from "./core.js";

export const PLUGIN_ID = "dominusnode";

export interface OpenClawToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface OpenClawTool {
  name: string;
  description: string;
  /** JSON Schema (TypeBox-compatible). */
  parameters: JsonSchemaObject;
  execute(id: string, params: Record<string, unknown>): Promise<OpenClawToolResult>;
}

/** Minimal slice of the OpenClaw plugin API used here. */
export interface OpenClawPluginApi {
  registerTool(tool: OpenClawTool, opts?: { name?: string; optional?: boolean }): void;
  /** Plugin config from openclaw.plugin.json configSchema (may be absent). */
  pluginConfig?: Record<string, unknown>;
}

export type OpenClawToolName = `dominusnode_${StandardToolName}`;

/** Build the 19 OpenClaw tool definitions. */
export function createOpenClawTools(config: DominusNodeToolsConfig = {}): OpenClawTool[] {
  const provider = new ClientProvider(config);
  return createToolSpecs().map((spec) => ({
    name: `dominusnode_${spec.name}`,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_id: string, params: Record<string, unknown>): Promise<OpenClawToolResult> {
      const text = await runTool(spec, provider, params);
      return { content: [{ type: "text", text }], details: { tool: spec.name, ok: !text.startsWith("Error:") } };
    },
  }));
}

function configFrom(api: OpenClawPluginApi): DominusNodeToolsConfig {
  const c = api.pluginConfig ?? {};
  // The API key is deliberately NOT read from plugin config: env (or the OpenClaw secret store
  // exporting DOMINUSNODE_API_KEY) only.
  return {
    baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : undefined,
    proxyHost: typeof c.proxyHost === "string" ? c.proxyHost : undefined,
  };
}

const plugin = {
  id: PLUGIN_ID,
  name: "DominusNode relay network",
  description:
    "Fetch the web through the DominusNode AI-agent relay network (residential, datacenter and mobile exits), " +
    "check live pricing, wallet, usage and node earnings.",
  register(api: OpenClawPluginApi): void {
    for (const tool of createOpenClawTools(configFrom(api))) api.registerTool(tool);
  },
};

export default plugin;
