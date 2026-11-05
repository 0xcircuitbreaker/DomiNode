import type { X402FacilitatorAdapter } from "../types.js";
import { NotConfiguredError } from "../types.js";

/** Placeholder for an operator-run facilitator: always NotConfigured. */
export const selfhostedFacilitator: X402FacilitatorAdapter = {
  id: "selfhosted",
  async verify() {
    throw new NotConfiguredError("selfhosted x402 facilitator");
  },
  async settle() {
    throw new NotConfiguredError("selfhosted x402 facilitator");
  },
};
