import { ICredentialType, INodeProperties } from "n8n-workflow";

export class DominusNodeApi implements ICredentialType {
  name = "dominusNodeApi";
  displayName = "Dominus Node API";
  documentationUrl = "https://docs.dominusnode.com";
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: 'Dominus Node API key (starts with dn_live_ or dn_test_)',
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.dominusnode.com",
      description: "Dominus Node API base URL",
    },
    {
      displayName: "Proxy Host",
      name: "proxyHost",
      type: "string",
      default: "proxy.dominusnode.com",
      description: "Dominus Node proxy gateway hostname",
    },
    {
      displayName: "Proxy Port",
      name: "proxyPort",
      type: "number",
      default: 8080,
      description: "Dominus Node proxy gateway port",
    },
    {
      displayName: "Agent Secret",
      name: "agentSecret",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "Optional agent secret for AI/MCP captcha bypass. When set, injects X-DominusNode-Agent and X-DominusNode-Agent-Secret headers.",
    },
  ];
}
