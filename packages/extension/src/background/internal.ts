import type { PricingResponse } from "../shared/api-client.js";
import { isPlainObject } from "../shared/json.js";
import type { Controller } from "./controller.js";

/** Messages from the extension's own popup/options pages. */
export async function handleInternal(
  ctl: Controller,
  message: unknown,
  fetchPricing: () => Promise<PricingResponse>,
): Promise<unknown> {
  if (!isPlainObject(message) || typeof message.type !== "string") throw new Error("Invalid message");
  const p = message.payload;
  switch (message.type) {
    case "getStatus":
      return ctl.status();
    case "updateSettings":
      await ctl.operatorUpdate(p);
      return ctl.status();
    case "setApiKey":
      if (ctl.managedKeys.includes("apiKey")) throw new Error("apiKey is set by enterprise policy");
      if (p !== null && typeof p !== "string") throw new Error("Invalid key");
      await ctl.setApiKey(p === null ? null : p.trim());
      return ctl.status();
    case "importConfig":
      await ctl.importConfig(p);
      return ctl.status();
    case "rotateSession":
      await ctl.rotateSession();
      return ctl.status();
    case "resetRun":
      await ctl.resetRun();
      return ctl.status();
    case "refreshBalance":
      await ctl.pollBalance();
      return ctl.status();
    case "checkExit":
      await ctl.checkExit();
      return ctl.status();
    case "getPricing":
      return fetchPricing();
    case "getNodeInfo": {
      const c = ctl.accountClient();
      const [nodes, tier, credits] = await Promise.allSettled([c.nodes(), c.tier(), c.credits()]);
      const val = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
      const err = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : null);
      return {
        nodes: val(nodes)?.nodes ?? [],
        tier: val(tier),
        credits: val(credits),
        errors: [err(nodes), err(tier), err(credits)].filter(Boolean),
      };
    }
    case "getPlatform":
      return (await chrome.runtime.getPlatformInfo()).os;
    default:
      throw new Error("Unknown message type");
  }
}
