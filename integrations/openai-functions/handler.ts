/**
 * DominusNode function definitions and handler for OpenAI-compatible function/tool calling.
 *
 * `functionDefinitions` are plain `{name, description, parameters}` JSON Schema definitions (`functions.json`);
 * `chatCompletionTools` wraps them as Chat Completions `tools`, `responsesTools` as Responses API tools.
 * The handler executes a tool call through `@dominusnode/sdk` and resolves to a JSON string.
 * The API key comes from config or DOMINUSNODE_API_KEY, never from the model.
 */
import { DominusNodeTools, PREFIX, TOOL_SPECS, type DominusNodeToolsConfig, type ToolSpec } from "./core.js";

export { DominusNodeTools, TOOL_NAMES, TOOL_SPECS, NODE_SETUP_GUIDE } from "./core.js";
export type { DominusNodeToolsConfig, SdkClient, ToolSpec } from "./core.js";

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: ToolSpec["parameters"];
}

export function toDeclaration(spec: ToolSpec): FunctionDefinition {
  return { name: PREFIX + spec.name, description: spec.description, parameters: structuredClone(spec.parameters) };
}

export const functionDefinitions: FunctionDefinition[] = TOOL_SPECS.map(toDeclaration);
/** Alias kept for symmetry with the Gemini package. */
export const functionDeclarations = functionDefinitions;

/** Chat Completions: `client.chat.completions.create({ tools: chatCompletionTools, ... })`. */
export const chatCompletionTools = functionDefinitions.map((f) => ({ type: "function" as const, function: f }));
/** Responses API: `client.responses.create({ tools: responsesTools, ... })`. */
export const responsesTools = functionDefinitions.map((f) => ({ type: "function" as const, ...f }));

export type FunctionHandler = (name: string, args?: Record<string, unknown> | string) => Promise<string>;

/**
 * Create a handler for tool calls. Accepts parsed args or the raw JSON `arguments` string from the model.
 *
 * @example
 * ```ts
 * const handle = createDominusNodeFunctionHandler();           // key from DOMINUSNODE_API_KEY
 * for (const call of completion.choices[0].message.tool_calls ?? []) {
 *   const content = await handle(call.function.name, call.function.arguments);
 *   messages.push({ role: "tool", tool_call_id: call.id, content });
 * }
 * ```
 */
export function createDominusNodeFunctionHandler(config: DominusNodeToolsConfig = {}): FunctionHandler {
  const tools = new DominusNodeTools(config);
  return async (name, args = {}) => {
    let parsed: Record<string, unknown>;
    if (typeof args === "string") {
      try {
        const v: unknown = args.trim() ? JSON.parse(args) : {};
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        parsed = v as Record<string, unknown>;
      } catch {
        return JSON.stringify({ error: "arguments must be a JSON object" });
      }
    } else {
      parsed = args;
    }
    // JSON.parse may yield own __proto__/constructor keys; drop them before dispatch.
    for (const k of ["__proto__", "constructor", "prototype"]) delete parsed[k];
    return tools.call(name, parsed);
  };
}
