/**
 * DominusNode extension for pi (pi-mono coding agent): registers the 19 standard v2 tools.
 *
 *   export DOMINUSNODE_API_KEY=dn_live_...
 *   pi install npm:@dominusnode/pi-extension
 */
import { Type, type TSchema } from "typebox";
import {
  ClientProvider,
  createToolSpecs,
  runTool,
  type DominusNodeToolsConfig,
  type JsonSchemaObject,
  type JsonSchemaProperty,
} from "./core.js";

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

export interface PiToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<PiToolResult>;
}

/** The slice of pi's ExtensionAPI used here. */
export interface ExtensionAPI {
  registerTool(tool: PiTool): void;
}

function prop(p: JsonSchemaProperty): TSchema {
  const meta = { description: p.description };
  if (p.enum) return Type.Union(p.enum.map((v) => Type.Literal(v)), meta);
  if (p.type === "integer") return Type.Integer({ ...meta, minimum: p.minimum, maximum: p.maximum });
  if (p.type === "boolean") return Type.Boolean(meta);
  return Type.String(meta);
}

/** Convert a core JSON schema into the equivalent TypeBox object schema. */
export function toTypeBox(schema: JsonSchemaObject): TSchema {
  const shape: Record<string, TSchema> = {};
  for (const [k, p] of Object.entries(schema.properties)) {
    shape[k] = schema.required.includes(k) ? prop(p) : Type.Optional(prop(p));
  }
  return Type.Object(shape, { additionalProperties: false });
}

/** Build the 19 pi tool definitions. */
export function createPiTools(config: DominusNodeToolsConfig = {}): PiTool[] {
  const provider = new ClientProvider(config);
  return createToolSpecs().map((spec) => ({
    name: `dominusnode_${spec.name}`,
    label: `DominusNode: ${spec.title}`,
    description: spec.description,
    parameters: toTypeBox(spec.parameters),
    async execute(_id, params) {
      const text = await runTool(spec, provider, params);
      return { content: [{ type: "text" as const, text }], details: { tool: spec.name, ok: !text.startsWith("Error:") } };
    },
  }));
}

/** Extension entry point, called by pi on load. The API key comes from DOMINUSNODE_API_KEY only. */
export default function dominusNodeExtension(pi: ExtensionAPI): void {
  for (const tool of createPiTools()) pi.registerTool(tool);
}
