// Internal runtime barrel for socket-chat extension.
// All SDK subpath imports are centralised here.
// Production files import from "./runtime-api.js" — never directly from "openclaw/plugin-sdk/*".

export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/status-helpers";

export { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export {
  deliverFormattedTextWithAttachments,
  buildMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
export { resolveChannelMediaMaxBytes, detectMime } from "openclaw/plugin-sdk/media-runtime";
export { resolveAllowlistMatchByCandidates } from "openclaw/plugin-sdk/allow-from";
export {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk/status-helpers";
