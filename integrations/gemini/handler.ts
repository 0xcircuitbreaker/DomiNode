/**
 * DominusNode function declarations and handler for Google Gemini / Vertex AI function calling.
 *
 * `functionDeclarations` go in `config.tools[0].functionDeclarations` (@google/genai) and the handler
 * executes a model's `functionCall` through `@dominusnode/sdk`, returning a JSON string you send back as a
 * `functionResponse`. The API key comes from config or DOMINUSNODE_API_KEY, never from the model.
 */
import { DominusNodeTools, PREFIX, TOOL_NAMES, TOOL_SPECS, type DominusNodeToolsConfig, type ToolSpec } from "./core.js";

export { DominusNodeTools, TOOL_NAMES, TOOL_SPECS, NODE_SETUP_GUIDE } from "./core.js";
export type { DominusNodeToolsConfig, SdkClient, ToolSpec } from "./core.js";

/** Gemini OpenAPI-subset schema (uppercase types). */
export interface GeminiSchema {
  type: "OBJECT" | "STRING" | "INTEGER" | "BOOLEAN";
  description?: string;
  enum?: string[];
  format?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
}
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

/** Convert a core tool spec to a Gemini FunctionDeclaration (no additionalProperties/min/max: unsupported). */
export function toDeclaration(spec: ToolSpec): GeminiFunctionDeclaration {
  const properties: Record<string, GeminiSchema> = {};
  for (const [k, p] of Object.entries(spec.parameters.properties)) {
    const s: GeminiSchema = { type: p.type.toUpperCase() as GeminiSchema["type"], description: p.description };
    if (p.enum) {
      s.format = "enum";
      s.enum = [...p.enum];
    }
    properties[k] = s;
  }
  return {
    name: PREFIX + spec.name,
    description: spec.description,
    parameters: { type: "OBJECT", properties, required: [...spec.parameters.required] },
  };
}

export const functionDeclarations: GeminiFunctionDeclaration[] = TOOL_SPECS.map(toDeclaration);

export type FunctionHandler = (name: string, args?: Record<string, unknown>) => Promise<string>;

/**
 * Create a handler for Gemini function calls.
 *
 * @example
 * ```ts
 * const ai = new GoogleGenAI({});
 * const handle = createDominusNodeFunctionHandler();           // key from DOMINUSNODE_API_KEY
 * const res = await ai.models.generateContent({ model, contents,
 *   config: { tools: [{ functionDeclarations }] } });
 * for (const call of res.functionCalls ?? []) {
 *   const result = await handle(call.name!, call.args ?? {});
 *   // send back: { functionResponse: { name: call.name, response: JSON.parse(result) } }
 * }
 * ```
 */
export function createDominusNodeFunctionHandler(config: DominusNodeToolsConfig = {}): FunctionHandler {
  const tools = new DominusNodeTools(config);
  return (name, args = {}) => tools.call(name, args);
}

export { TOOL_NAMES as toolNames };
