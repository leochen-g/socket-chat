/**
 * Minimal openclaw/plugin-sdk stub for shellbot-chat unit tests.
 *
 * Only re-exports the symbols that shellbot-chat/src actually imports at runtime.
 * This avoids pulling in the full SDK dependency tree (which includes modules
 * like json5 that require the openclaw monorepo workspace to resolve).
 */
export { resolveAllowlistMatchByCandidates } from "../../openclaw/src/channels/allowlist-match.js";
export { createNormalizedOutboundDeliverer } from "../../openclaw/src/plugin-sdk/reply-payload.js";
export { buildMediaPayload } from "../../openclaw/src/channels/plugins/media-payload.js";
export { resolveChannelMediaMaxBytes } from "../../openclaw/src/channels/plugins/media-limits.js";
export { detectMime } from "../../openclaw/src/media/mime.js";

// ---- type-only re-exports (erased at runtime) ----
export type { ChannelGatewayContext } from "../../openclaw/src/plugin-sdk/index.js";
