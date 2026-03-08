/**
 * Minimal openclaw/plugin-sdk stub for socket-chat unit tests.
 *
 * Only re-exports the symbols that socket-chat/src actually imports at runtime.
 * This avoids pulling in the full SDK dependency tree (which includes modules
 * like json5 that require the openclaw monorepo workspace to resolve).
 */
export { resolveAllowlistMatchByCandidates } from "../../openclaw/src/channels/allowlist-match.js";
export { createNormalizedOutboundDeliverer } from "../../openclaw/src/plugin-sdk/reply-payload.js";

// ---- type-only re-exports (erased at runtime) ----
export type { ChannelGatewayContext } from "../../openclaw/src/plugin-sdk/index.js";
