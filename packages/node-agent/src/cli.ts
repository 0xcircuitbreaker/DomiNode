/**
 * Subcommands that do not start the tunnel (currently `selfcheck`).
 * main.ts parses flags and config, then hands off here.
 */
import type { AgentConfig } from "./config.js";
import { exitCodeFor, formatResults, runSelfcheck, type SelfcheckDeps } from "./selfcheck.js";

export async function selfcheckCommand(
  cfg: Pick<AgentConfig, "keyFile" | "gatewayUrl" | "apiUrl" | "denyDomains">,
  flags: Readonly<Record<string, string | undefined>>,
  write: (s: string) => void = (s) => void process.stdout.write(s),
  deps: SelfcheckDeps = {},
): Promise<number> {
  const target = flags["dial-target"];
  if (target !== undefined && !/^[a-z0-9.-]{1,253}$/i.test(target)) {
    write("error: --dial-target must be a hostname\n");
    return 2;
  }
  const results = await runSelfcheck(
    { keyFile: cfg.keyFile, gatewayUrl: cfg.gatewayUrl, apiUrl: cfg.apiUrl, dialTarget: target, denyDomains: cfg.denyDomains },
    deps,
  );
  write(formatResults(results));
  return exitCodeFor(results);
}
