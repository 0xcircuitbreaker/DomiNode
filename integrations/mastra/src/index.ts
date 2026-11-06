/**
 * @dominusnode/mastra-tools: the DominusNode v2 standard tool set for Mastra agents.
 *
 *   import { Agent } from "@mastra/core/agent";
 *   import { DominusNodeToolkit } from "@dominusnode/mastra-tools";
 *
 *   const agent = new Agent({ name: "web", instructions: "...", model, tools: new DominusNodeToolkit().getTools() });
 */
import { createTool } from "@mastra/core/tools";
import { ClientProvider, createToolSpecs, runTool, type DominusNodeToolsConfig, type StandardToolName } from "./core.js";
import { toZod } from "./zod-schema.js";

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
export { toZod } from "./zod-schema.js";

export type DominusNodeToolId = `dominusnode_${StandardToolName}`;

export class DominusNodeToolkit {
  readonly #provider: ClientProvider;

  /** The API key defaults to DOMINUSNODE_API_KEY; pass `apiKey` only from your own config, never from model output. */
  constructor(config: DominusNodeToolsConfig = {}) {
    this.#provider = new ClientProvider(config);
  }

  /** The 19 tools keyed by id (`dominusnode_<name>`), as Mastra's `Agent({ tools })` expects. */
  getTools(): Record<DominusNodeToolId, ReturnType<typeof createTool>> {
    const tools: Record<string, ReturnType<typeof createTool>> = {};
    for (const spec of createToolSpecs()) {
      const id = `dominusnode_${spec.name}`;
      tools[id] = createTool({
        id,
        description: spec.description,
        inputSchema: toZod(spec.parameters),
        // Mastra >= 1.0: execute(inputData, context).
        execute: async (input: Record<string, unknown>) => runTool(spec, this.#provider, input),
      } as never);
    }
    return tools as Record<DominusNodeToolId, ReturnType<typeof createTool>>;
  }

  /** Clear the API key and tokens held by the SDK client. */
  async close(): Promise<void> {
    await this.#provider.disconnect();
  }

  toString(): string {
    return "DominusNodeToolkit([REDACTED])";
  }
  toJSON(): Record<string, unknown> {
    return { toolkit: "dominusnode" };
  }
}
