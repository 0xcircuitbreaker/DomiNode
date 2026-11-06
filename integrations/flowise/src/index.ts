/**
 * @dominusnode/flowise-tools: the DominusNode v2 standard tool set as LangChain
 * DynamicStructuredTool instances for Flowise (Custom Tool / Tool Agent flows).
 *
 *   import { DominusNodeToolkit } from "@dominusnode/flowise-tools";
 *   const tools = new DominusNodeToolkit().getTools(); // reads DOMINUSNODE_API_KEY
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ClientProvider, createToolSpecs, runTool, type DominusNodeToolsConfig } from "./core.js";
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

export class DominusNodeToolkit {
  readonly #provider: ClientProvider;

  /** The API key defaults to DOMINUSNODE_API_KEY; in Flowise pass it from a credential, never from model output. */
  constructor(config: DominusNodeToolsConfig = {}) {
    this.#provider = new ClientProvider(config);
  }

  /** The 19 tools, named `dominusnode_<name>`. Each returns a JSON string or a scrubbed "Error: ..." string. */
  getTools(): DynamicStructuredTool[] {
    return createToolSpecs().map(
      (spec) =>
        new DynamicStructuredTool({
          name: `dominusnode_${spec.name}`,
          description: spec.description,
          schema: toZod(spec.parameters),
          func: async (input: Record<string, unknown>) => runTool(spec, this.#provider, input),
        } as never),
    );
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
