import type { ICredentialType, INodeProperties } from "n8n-workflow";

/** Stored in n8n's encrypted credentials store; the key is never a node parameter. */
export class DominusNodeApi implements ICredentialType {
  name = "dominusNodeApi";
  displayName = "DominusNode API";
  documentationUrl = "https://github.com/0xcircuitbreaker/DomiNode/tree/master/integrations/n8n";
  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "DominusNode API key (dn_live_... or dn_test_...)",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.dominusnode.com",
      description: "DominusNode API base URL",
    },
    {
      displayName: "Proxy Host",
      name: "proxyHost",
      type: "string",
      default: "proxy.dominusnode.com",
      description: "Relay gateway hostname",
    },
    {
      displayName: "Proxy TLS Port",
      name: "proxyTlsPort",
      type: "number",
      default: 8443,
      description: "Relay gateway HTTPS proxy (TLS) port: 8443 for the hosted gateway, usually 8444 for a self-hosted coordinator",
    },
    {
      displayName: "Plaintext Gateway (Local Dev Only)",
      name: "insecureProxy",
      type: "boolean",
      default: false,
      description: "Whether to send the API key to the gateway without TLS. Production gateways refuse this.",
    },
    {
      displayName: "Plaintext Proxy Port",
      name: "proxyPort",
      type: "number",
      default: 8080,
      description: "Relay gateway plaintext HTTP port, used only with Plaintext Gateway",
    },
  ];
}
