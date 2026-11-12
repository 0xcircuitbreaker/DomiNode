/**
 * Narrow re-exports from @dominusnode/shared. Deep imports keep the node agent
 * free of the DB/auth/email modules pulled in by the shared package index.
 */
export {
  isValidHostname,
  isValidPort,
  isPublicAddress,
  isBlockedIp,
} from "@dominusnode/shared/dist/src/net-guard.js";
export { FLOOR_ALLOWED_PORTS, HARD_DENY_PORTS } from "@dominusnode/shared/dist/src/policy.js";
export {
  FrameType,
  FrameDecoder,
  encodeFrame,
  encodeControl,
  decodeControl,
  stripDangerousKeys,
  TunnelProtocolError,
  MAX_FRAME_PAYLOAD,
  FLAG_FIN,
  FLAG_RST,
} from "@dominusnode/shared/dist/src/tunnel/frame.js";
export type { Frame } from "@dominusnode/shared/dist/src/tunnel/frame.js";
export {
  challengeMessage,
  authMessage,
  signEd25519,
  verifyEd25519,
  loadEd25519PrivateKey,
  EXPORTER_LABEL,
  EXPORTER_LENGTH,
  type ChannelBinding,
} from "@dominusnode/shared/dist/src/tunnel/auth-sig.js";
export { pqTlsOptions, reportTlsCapability } from "@dominusnode/shared/dist/src/tls-pq.js";
