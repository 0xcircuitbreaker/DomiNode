import type { X402Facilitator } from "../../x402.js";
import type { X402FacilitatorAdapter, X402FacilitatorId } from "../types.js";
import { coinbaseFacilitator } from "./coinbase.js";
import { payaiFacilitator } from "./payai.js";
import { selfhostedFacilitator } from "./selfhosted.js";

export { FACILITATOR_URLS } from "./urls.js";
export { coinbaseFacilitator, payaiFacilitator, selfhostedFacilitator };

const REGISTRY: Record<X402FacilitatorId, X402FacilitatorAdapter> = {
  coinbase: coinbaseFacilitator,
  payai: payaiFacilitator,
  selfhosted: selfhostedFacilitator,
};

export function getFacilitator(id: X402FacilitatorId): X402FacilitatorAdapter {
  const f = Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id] : undefined;
  if (!f) throw new Error("Unknown x402 facilitator");
  return f;
}

/** X402_FACILITATOR env override of detectFacilitator (allowlisted network facilitators only). */
export function facilitatorOverride(): X402Facilitator | null {
  const v = process.env["X402_FACILITATOR"];
  return v === "coinbase" || v === "payai" ? v : null;
}
