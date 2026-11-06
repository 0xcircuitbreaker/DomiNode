/**
 * @dominusnode/chatgpt: dispatch ChatGPT / OpenAI function calls for the 19 standard
 * DominusNode v2 tools to @dominusnode/sdk.
 *
 *   import { createDominusNodeFunctionHandler, openAIFunctions } from "@dominusnode/chatgpt";
 *   const handler = createDominusNodeFunctionHandler(); // reads DOMINUSNODE_API_KEY
 *   // pass openAIFunctions() as `tools`, then for each tool call:
 *   const text = await handler(call.function.name, JSON.parse(call.function.arguments));
 */
import { ClientProvider, createToolSpecs, runTool, safeError, scrubDeep, type DominusNodeToolsConfig, type JsonSchemaObject } from "./core.js";

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

export const FUNCTION_PREFIX = "dominusnode_";

export interface OpenAIFunctionDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  strict?: boolean;
}

/** OpenAI function definitions (`{ name, description, parameters }`) for the 19 tools. Same content as functions.json. */
export function functionDefinitions(): OpenAIFunctionDefinition[] {
  return createToolSpecs().map((s) => ({ name: `${FUNCTION_PREFIX}${s.name}`, description: s.description, parameters: s.parameters }));
}

/** Chat Completions `tools` array: `[{ type: "function", function: {...} }]`. */
export function openAIFunctions(): Array<{ type: "function"; function: OpenAIFunctionDefinition }> {
  return functionDefinitions().map((f) => ({ type: "function" as const, function: f }));
}

export type FunctionHandler = (name: string, args: unknown) => Promise<string>;

/** Returns a dispatcher: name (with or without the `dominusnode_` prefix) + parsed args -> JSON string or scrubbed "Error: ...". */
export function createDominusNodeFunctionHandler(config: DominusNodeToolsConfig = {}): FunctionHandler {
  const provider = new ClientProvider(config);
  const specs = new Map(createToolSpecs().map((s) => [s.name as string, s]));
  return async (name: string, args: unknown) => {
    const key = typeof name === "string" && name.startsWith(FUNCTION_PREFIX) ? name.slice(FUNCTION_PREFIX.length) : name;
    const spec = specs.get(key);
    if (!spec) return safeError(new Error(`Unknown function: ${String(name).slice(0, 100)}`));
    let parsed = args;
    if (typeof args === "string") {
      try {
        // scrubDeep also drops __proto__/constructor/prototype keys.
        parsed = scrubDeep(JSON.parse(args));
      } catch {
        return safeError(new Error("arguments must be a JSON object"));
      }
    }
    return runTool(spec, provider, parsed);
  };
}
