/**
 * @dominusnode/ai-tools: the DominusNode v2 standard tool set for the Vercel AI SDK.
 *
 *   import { generateText } from "ai";
 *   import { createDominusNodeTools } from "@dominusnode/ai-tools";
 *
 *   const tools = createDominusNodeTools(); // reads DOMINUSNODE_API_KEY
 *   await generateText({ model, tools, prompt: "Fetch https://example.com from Germany" });
 */
import { tool, jsonSchema } from "ai";
import { ClientProvider, createToolSpecs, runTool, type DominusNodeToolsConfig, type StandardToolName } from "./core.js";

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

/** Tool name used with the Vercel AI SDK: `dominusnode_<standard name>`. */
export type DominusNodeToolName = `dominusnode_${StandardToolName}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DominusNodeTools = Record<DominusNodeToolName, any>;

/** Create the 19 DominusNode tools keyed by name, ready for `generateText({ tools })` / `streamText`. */
export function createDominusNodeTools(config: DominusNodeToolsConfig = {}): DominusNodeTools {
  const provider = new ClientProvider(config);
  const tools: Record<string, unknown> = {};
  for (const spec of createToolSpecs()) {
    tools[`dominusnode_${spec.name}`] = tool({
      description: spec.description,
      inputSchema: jsonSchema<Record<string, unknown>>(spec.parameters as never),
      execute: async (input: Record<string, unknown>) => runTool(spec, provider, input),
    });
  }
  return tools as DominusNodeTools;
}
