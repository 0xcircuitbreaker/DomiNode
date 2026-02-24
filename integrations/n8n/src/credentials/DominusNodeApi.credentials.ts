import { ICredentialType, INodeProperties } from "n8n-workflow";

export class DominusNodeApi implements ICredentialType {
  name = "dominusNodeApi";
  displayName = "DomiNode API";
  documentationUrl = "https://docs.dominusnode.com";
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: 'DomiNode API key (starts with dn_live_ or dn_test_)',
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.dominusnode.com",
      description: "DomiNode API base URL",
    },
    {
      displayName: "Proxy Host",
      name: "proxyHost",
      type: "string",
      default: "proxy.dominusnode.com",
      description: "DomiNode proxy gateway hostname",
    },
    {
      displayName: "Proxy Port",
      name: "proxyPort",
      type: "number",
      default: 8080,
      description: "DomiNode proxy gateway port",
    },
  ];
}
