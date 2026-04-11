/**
 * Minimal openclaw/plugin-sdk stub for socket-chat unit tests.
 *
 * Handles the broad "openclaw/plugin-sdk" fallback alias in vitest.config.ts.
 * Per-subpath imports (openclaw/plugin-sdk/*) are resolved directly via
 * individual aliases defined in vitest.config.ts.
 */
export { createPluginRuntimeStore } from "../../openclaw/src/plugin-sdk/runtime-store.js";
export { createChannelPairingController } from "../../openclaw/src/plugin-sdk/channel-pairing.js";
export { createAccountStatusSink } from "../../openclaw/src/plugin-sdk/channel-lifecycle.js";
export { dispatchInboundReplyWithBase } from "../../openclaw/src/plugin-sdk/inbound-reply-dispatch.js";
export {
  deliverFormattedTextWithAttachments,
  buildMediaPayload,
} from "../../openclaw/src/plugin-sdk/reply-payload.js";
export { resolveChannelMediaMaxBytes, detectMime } from "../../openclaw/src/plugin-sdk/media-runtime.js";
export { resolveAllowlistMatchByCandidates } from "../../openclaw/src/plugin-sdk/allow-from.js";
export {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "../../openclaw/src/plugin-sdk/status-helpers.js";

// ---- type-only re-exports (erased at runtime) ----
export type { PluginRuntime } from "../../openclaw/src/plugin-sdk/runtime-store.js";
export type { OutboundReplyPayload } from "../../openclaw/src/plugin-sdk/reply-payload.js";
export type { ChannelPlugin } from "../../openclaw/src/plugin-sdk/channel-core.js";
export { createChatChannelPlugin } from "../../openclaw/src/plugin-sdk/channel-core.js";
export type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "../../openclaw/src/plugin-sdk/status-helpers.js";
export type { ChannelGatewayContext } from "../../openclaw/src/plugin-sdk/index.js";
