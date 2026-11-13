/**
 * DominusNode n8n community node: one node, 19 operations (the standard v2 tool set),
 * built on @dominusnode/sdk. Marked usableAsTool so n8n AI Agents can call it.
 */
import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeProperties,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
} from "n8n-workflow";
import {
  ClientProvider,
  createToolSpecs,
  safeError,
  scrubDeep,
  type DominusNodeToolSpec,
  type JsonSchemaProperty,
} from "../../core.js";

/** snake_case standard name -> n8n operation value (camelCase). */
export function operationValue(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function displayName(key: string): string {
  return key
    .split("_")
    .map((w) => (w === "id" ? "ID" : w === "ip" ? "IP" : w === "musd" ? "µUSD" : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function field(key: string, p: JsonSchemaProperty, required: boolean): INodeProperties {
  const base = { displayName: displayName(key), name: key, description: p.description, required };
  if (p.enum) {
    return { ...base, type: "options", options: p.enum.map((v) => ({ name: v, value: v })), default: p.enum[0] };
  }
  if (p.type === "integer") {
    return { ...base, type: "number", typeOptions: { minValue: p.minimum, maxValue: p.maximum, numberPrecision: 0 }, default: p.minimum ?? 0 };
  }
  if (p.type === "boolean") return { ...base, type: "boolean", default: false };
  return { ...base, type: "string", default: "" };
}

const SPECS = createToolSpecs();

function buildProperties(): INodeProperties[] {
  const options: INodePropertyOptions[] = SPECS.map((s) => ({
    name: s.title,
    value: operationValue(s.name),
    description: s.description,
    action: s.title,
  }));
  const props: INodeProperties[] = [
    { displayName: "Operation", name: "operation", type: "options", noDataExpression: true, options, default: "fetch" },
  ];
  for (const s of SPECS) {
    const show = { show: { operation: [operationValue(s.name)] } };
    const entries = Object.entries(s.parameters.properties);
    for (const [k, p] of entries.filter(([k]) => s.parameters.required.includes(k))) {
      props.push({ ...field(k, p, true), displayOptions: show });
    }
    const optional = entries.filter(([k]) => !s.parameters.required.includes(k));
    if (optional.length) {
      props.push({
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: show,
        options: optional.map(([k, p]) => field(k, p, false)),
      });
    }
  }
  return props;
}

export class DominusNode implements INodeType {
  description: INodeTypeDescription = {
    displayName: "DominusNode",
    name: "dominusNode",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 2,
    subtitle: '={{$parameter["operation"]}}',
    description:
      "DominusNode AI-agent relay network: fetch pages via residential/datacenter/mobile exits, live pricing, wallet, usage and node earnings",
    defaults: { name: "DominusNode" },
    inputs: ["main"],
    outputs: ["main"],
    usableAsTool: true,
    credentials: [{ name: "dominusNodeApi", required: true }],
    properties: buildProperties(),
  } as INodeTypeDescription;

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const creds = (await this.getCredentials("dominusNodeApi")) as IDataObject;
    const port = Number(creds.proxyPort);
    const tlsPort = Number(creds.proxyTlsPort);
    const provider = new ClientProvider({
      apiKey: typeof creds.apiKey === "string" ? creds.apiKey : undefined,
      baseUrl: typeof creds.baseUrl === "string" && creds.baseUrl ? creds.baseUrl : undefined,
      proxyHost: typeof creds.proxyHost === "string" && creds.proxyHost ? creds.proxyHost : undefined,
      httpProxyPort: Number.isInteger(port) && port > 0 ? port : undefined,
      tlsProxyPort: Number.isInteger(tlsPort) && tlsPort > 0 ? tlsPort : undefined,
      // Credentials saved before 2.2 have no proxyTlsPort and default to TLS on 8443.
      insecureProxy: creds.insecureProxy === true,
    });
    const out: INodeExecutionData[] = [];
    try {
      for (let i = 0; i < items.length; i++) {
        const op = this.getNodeParameter("operation", i) as string;
        const spec: DominusNodeToolSpec | undefined = SPECS.find((s) => operationValue(s.name) === op);
        try {
          if (!spec) throw new Error(`Unknown operation: ${op}`);
          const args: Record<string, unknown> = {};
          for (const k of spec.parameters.required) args[k] = this.getNodeParameter(k, i);
          const hasOptional = Object.keys(spec.parameters.properties).some((k) => !spec.parameters.required.includes(k));
          if (hasOptional) Object.assign(args, this.getNodeParameter("options", i, {}) as IDataObject);
          const client = spec.public ? provider.publicClient : await provider.connected();
          const result = scrubDeep(await spec.run(client, args));
          out.push({ json: (result && typeof result === "object" ? result : { result }) as IDataObject, pairedItem: { item: i } });
        } catch (err) {
          const message = safeError(err).replace(/^Error: /, "");
          if (this.continueOnFail()) {
            out.push({ json: { error: message }, pairedItem: { item: i } });
            continue;
          }
          throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
        }
      }
    } finally {
      await provider.disconnect().catch(() => undefined);
    }
    return [out];
  }
}
