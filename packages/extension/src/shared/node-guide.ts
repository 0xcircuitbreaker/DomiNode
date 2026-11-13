/**
 * "Contribute this machine" guide. Mirrors the MCP server's dominusnode_node_setup_guide
 * (packages/mcp-server/src/tools/nodes.ts nodeSetupGuide) with commands for the user's OS.
 * The extension never installs or runs anything: relaying needs raw TCP and must not
 * run inside the browser.
 */
export type GuideOs = "linux" | "mac" | "win";

export interface GuideStep {
  title: string;
  text?: string[];
  commands?: string[];
}

export function osFromPlatform(os: string | undefined): GuideOs {
  if (os === "win") return "win";
  if (os === "mac") return "mac";
  return "linux";
}

const IMAGE = "ghcr.io/0xcircuitbreaker/dominusnode-node";

export function nodeSetupGuide(os: GuideOs): GuideStep[] {
  const win = os === "win";
  const keyDir = win ? "$env:USERPROFILE\\.dominusnode" : "~/.dominusnode";
  const linux = os === "linux";
  // On Linux the container user (uid 1001) must own the files; Docker Desktop (mac/win) maps ownership.
  const mount = win ? "${env:USERPROFILE}\\.dominusnode" : linux ? "/etc/dominusnode" : "$HOME/.dominusnode";
  return [
    {
      title: "How earning works",
      text: [
        "Your node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.",
        "You earn your tier's share (Probation 25% ... Partner 50%) of each paid GB relayed; live prices and shares are under Pricing. Earnings mature before becoming available.",
        "Self-dealing earns nothing: traffic from you, your wallet, your team or your /24 is never routed to your node, and any that slips through settles with a zero node share.",
        "Tiers rise with paid tenure, uptime, active IPs (distinct /32s with 3+ paying requesters in 7d) and reputation.",
        "The node floor is fixed: only ports 80/443, never private/loopback/metadata targets, never SMTP/SSH/RDP, connection metadata only (no payload logging).",
      ],
    },
    {
      title: "Prerequisites",
      text: [
        "A wallet-linked account and a dn_live_ API key (not a team key).",
        "Docker on the machine whose IP you contribute (the official image ghcr.io/0xcircuitbreaker/dominusnode-node).",
        "IPs in sanctioned countries (Cuba, Iran, North Korea, Russia, Syria) cannot join.",
      ],
    },
    {
      title: "Step 1: Store the owner wallet key in a private file (never pass it as an argument)",
      commands: win
        ? [
            `New-Item -ItemType Directory -Force ${keyDir} | Out-Null`,
            `Set-Content -NoNewline -Path ${keyDir}\\wallet.key -Value $env:WALLET_PRIVATE_KEY_HEX`,
            `icacls ${keyDir}\\wallet.key /inheritance:r /grant:r "$env:USERNAME:R"`,
          ]
        : [
            `mkdir -p ${keyDir} && chmod 700 ${keyDir}`,
            `umask 077 && printf '%s' "$WALLET_PRIVATE_KEY_HEX" > ${keyDir}/wallet.key && chmod 600 ${keyDir}/wallet.key`,
          ],
    },
    {
      title: "Step 2: Register the node with the official node image (on the node machine)",
      commands: [
        win ? "$env:DN_API_KEY = Read-Host -MaskInput 'dn_live_ key'" : "read -rs DN_API_KEY && export DN_API_KEY   # your dn_live_ key, from env only",
        ...(linux
          ? [
              "sudo install -d -o 1001 -g 1001 -m 700 /etc/dominusnode",
              `sudo install -o 1001 -g 1001 -m 600 ${keyDir}/wallet.key /etc/dominusnode/wallet.key && rm ${keyDir}/wallet.key`,
            ]
          : []),
        `docker run --rm -e DN_API_KEY -e DN_WALLET_KEY_FILE=/run/dominusnode/wallet.key -v ${mount}:/run/dominusnode ${IMAGE} register`,
        win
          ? `Remove-Item ${keyDir}\\wallet.key   # not needed after registration`
          : `${linux ? "sudo " : ""}rm ${mount}/wallet.key   # not needed after registration`,
      ],
      text: [
        `Writes ${mount}${win ? "\\" : "/"}node.json (private, mode 0600).`,
        "Alternatively, register from the MCP server with dominusnode_node_register and copy the node file here.",
      ],
    },
    {
      title: "Step 3: Run the node agent on the machine that owns the IP",
      commands: [`docker run -d --name dominusnode-node --restart unless-stopped -v ${mount}:/run/dominusnode:ro ${IMAGE}`],
      text: [
        "Optional limits (can only tighten), passed with -e: DN_NODE_PORTS=443 DN_NODE_MAX_STREAMS=32 DN_NODE_GB_PER_DAY=5 DN_NODE_REQ_PER_SEC=20",
        "Env equivalents: DN_NODE_KEY_FILE, DN_NODE_PORTS, DN_NODE_MAX_STREAMS, DN_NODE_GB_PER_DAY, DN_NODE_REQ_PER_SEC, DN_NODE_MAX_MBPS, DN_NODE_DENY_DOMAINS, DN_NODE_API_URL, DN_NODE_GATEWAY_URL.",
        "The restart policy keeps it running - uptime drives your tier.",
      ],
    },
    {
      title: "Step 4: Verify",
      text: [
        "The Nodes tab shows status, observed IP, class and last-seen time once the tunnel is up.",
        "Revoking a node is permanent; do it from the MCP server (dominusnode_node_revoke) or the API.",
      ],
    },
  ];
}
