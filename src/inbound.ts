import {
  buildMediaPayload,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  detectMime,
  dispatchInboundReplyWithBase,
  resolveAllowlistMatchByCandidates,
  resolveChannelMediaMaxBytes,
  type OutboundReplyPayload,
} from "./runtime-api.js";
import { resolveSocketChatAccount, type CoreConfig } from "./config.js";
import type { SocketChatInboundMessage } from "./types.js";
import { getSocketChatRuntime } from "./runtime.js";

const CHANNEL_ID = "socket-chat" as const;

// ---------------------------------------------------------------------------
// Group access — track notified groups to avoid repeat "not allowed" messages
// ---------------------------------------------------------------------------

/**
 * Records groups that have already received a "not allowed" notification.
 * Keys are `${accountId}:${groupId}`. In-process only; resets on restart.
 */
const notifiedGroups = new Set<string>();

/** Only for tests — resets the in-process notification state. */
export function _resetNotifiedGroupsForTest(): void {
  notifiedGroups.clear();
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

type LogSink = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
};

// ---------------------------------------------------------------------------
// Main inbound handler
// ---------------------------------------------------------------------------

/**
 * Handle an inbound MQTT message:
 * 1. DM / group access control (allowlist / pairing challenge)
 * 2. Group @mention check
 * 3. Media file localization (HTTP URL or base64 → local path)
 * 4. Route resolution
 * 5. Dispatch AI reply via dispatchInboundReplyWithBase
 */
export async function handleSocketChatInbound(params: {
  msg: SocketChatInboundMessage;
  accountId: string;
  config: CoreConfig;
  log: LogSink;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  /** Send a text reply to the original sender (used for pairing challenge messages) */
  sendReply: (to: string, text: string) => Promise<void>;
}): Promise<void> {
  const { msg, accountId, config, log, statusSink, sendReply } = params;

  // Skip empty messages (media-only messages may have empty content but a url)
  if (!msg.content?.trim() && !msg.url) {
    log.debug?.(`[${accountId}] skip empty message ${msg.messageId}`);
    return;
  }

  statusSink?.({ lastInboundAt: msg.timestamp });

  const core = getSocketChatRuntime();
  const pairing = createChannelPairingController({ core, channel: CHANNEL_ID, accountId });
  const account = resolveSocketChatAccount(config, accountId);
  const replyTarget = msg.isGroup ? `group:${msg.groupId}` : msg.senderId;

  // ---- DM access control ----
  if (!msg.isGroup) {
    const dmPolicy = account.config.dmPolicy ?? "pairing";

    if (dmPolicy !== "open") {
      const configAllowFrom = (account.config.allowFrom ?? []).map((e) =>
        e.replace(/^(socket-chat|sc):/i, "").toLowerCase(),
      );
      const storeAllowFrom = (await pairing.readAllowFromStore()).map((e: string) =>
        e.toLowerCase(),
      );
      const mergedAllowFrom = [...configAllowFrom, ...storeAllowFrom];

      const senderId = msg.senderId.toLowerCase();
      const senderName = msg.senderName?.toLowerCase();
      const match = resolveAllowlistMatchByCandidates({
        allowList: mergedAllowFrom,
        candidates: [
          { value: senderId, source: "id" as const },
          ...(senderName ? [{ value: senderName, source: "name" as const }] : []),
        ],
      });

      if (!mergedAllowFrom.includes("*") && !match.allowed) {
        if (dmPolicy === "pairing") {
          await pairing.issueChallenge({
            senderId: msg.senderId,
            senderIdLine: `Your Socket Chat user id: ${msg.senderId}`,
            meta: { name: msg.senderName || undefined },
            sendPairingReply: async (text) => {
              await sendReply(replyTarget, text);
              statusSink?.({ lastOutboundAt: Date.now() });
            },
            onReplyError: (err) => {
              log.warn(
                `[${accountId}] pairing reply failed for ${msg.senderId}: ${String(err)}`,
              );
            },
          });
        } else {
          log.warn(`[${accountId}] blocked sender ${msg.senderId} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    }
  }

  // ---- Group access control ----
  if (msg.isGroup) {
    const groupId = msg.groupId ?? msg.senderId;
    const groupPolicy = account.config.groupPolicy ?? "open";

    if (groupPolicy === "disabled") {
      log.info(`[${accountId}] group msg blocked (groupPolicy=disabled)`);
      return;
    }

    if (groupPolicy === "allowlist") {
      const groups = (account.config.groups ?? []).map((g) =>
        g.replace(/^(socket-chat|sc):/i, "").trim().toLowerCase(),
      );
      const normalizedGroupId = groupId.replace(/^(socket-chat|sc):/i, "").trim().toLowerCase();
      if (!groups.includes("*") && !groups.includes(normalizedGroupId)) {
        const notifyKey = `${accountId}:${groupId}`;
        if (!notifiedGroups.has(notifyKey)) {
          notifiedGroups.add(notifyKey);
        }
        log.info(`[${accountId}] group ${groupId} not in groups allowlist`);
        return;
      }
    }

    // Sender-level allowlist within the group
    const groupAllowFrom = (account.config.groupAllowFrom ?? []).map((e) =>
      e.replace(/^(socket-chat|sc):/i, "").trim().toLowerCase(),
    );
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes("*")) {
      const normalizedSenderId = msg.senderId
        .replace(/^(socket-chat|sc):/i, "")
        .trim()
        .toLowerCase();
      const normalizedSenderName = msg.senderName?.trim().toLowerCase();
      const senderAllowed =
        groupAllowFrom.includes(normalizedSenderId) ||
        (normalizedSenderName !== undefined && groupAllowFrom.includes(normalizedSenderName));
      if (!senderAllowed) {
        log.info(`[${accountId}] group sender ${msg.senderId} not in groupAllowFrom`);
        return;
      }
    }

    // @Mention check
    const requireMention = account.config.requireMention !== false;
    if (requireMention) {
      const mentioned = msg.isGroupMention === true || msg.content.includes(`@${msg.robotId}`);
      if (!mentioned) {
        log.debug?.(`[${accountId}] group msg skipped (requireMention=true, not mentioned)`);
        return;
      }
    }
  }

  const chatType = msg.isGroup ? "group" : "direct";
  const peerId = msg.isGroup ? (msg.groupId ?? msg.senderId) : msg.senderId;
  const isMediaMsg = !!msg.type && msg.type !== "文字";
  const body = msg.content?.trim() || (isMediaMsg ? `<media:${msg.type}>` : "");

  // ---- Media localization ----
  let resolvedMediaPayload: Record<string, unknown> = {};
  const mediaUrl = msg.url?.trim();
  if (mediaUrl) {
    try {
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: config,
        resolveChannelLimitMb: ({ cfg }) =>
          (cfg as CoreConfig).channels?.["socket-chat"]?.mediaMaxMb,
        accountId,
      });

      let buffer: Buffer;
      let contentTypeHint: string | undefined;

      if (mediaUrl.startsWith("data:")) {
        // data URL: parse MIME and base64 payload
        const commaIdx = mediaUrl.indexOf(",");
        const meta = commaIdx > 0 ? mediaUrl.slice(5, commaIdx) : "";
        const base64Data = commaIdx > 0 ? mediaUrl.slice(commaIdx + 1) : "";
        contentTypeHint = meta.split(";")[0] || undefined;

        // Size preflight (base64 chars × 0.75 ≈ raw bytes)
        const estimatedBytes = Math.ceil(base64Data.length * 0.75);
        if (maxBytes && estimatedBytes > maxBytes) {
          log.warn(
            `[${accountId}] base64 media too large for ${msg.messageId} (est. ${estimatedBytes} bytes, limit ${maxBytes})`,
          );
          throw new Error("base64 media exceeds maxBytes limit");
        }

        buffer = Buffer.from(base64Data, "base64");
      } else {
        // HTTP/HTTPS URL: download via runtime media helper
        const fetched = await core.channel.media.fetchRemoteMedia({ url: mediaUrl, maxBytes });
        buffer = fetched.buffer;
        contentTypeHint = fetched.contentType;
      }

      const mime = await detectMime({ buffer, headerMime: contentTypeHint, filePath: mediaUrl });
      const saved = await core.channel.media.saveMediaBuffer(
        buffer,
        mime ?? contentTypeHint,
        "inbound",
        maxBytes,
      );
      resolvedMediaPayload = buildMediaPayload([
        { path: saved.path, contentType: saved.contentType },
      ]);
    } catch (err) {
      // Media failure must not block text dispatch
      log.warn(
        `[${accountId}] media localization failed for ${msg.messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- Route resolution ----
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: msg.isGroup ? "group" : "direct", id: peerId },
  });

  const fromLabel = msg.isGroup
    ? `socket-chat:room:${peerId}`
    : `socket-chat:${msg.senderId}`;
  const toLabel = `socket-chat:${replyTarget}`;
  const conversationLabel = msg.isGroup
    ? (msg.groupName ?? peerId)
    : (msg.senderName || msg.senderId);

  const storePath = core.channel.session.resolveStorePath(
    (config.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: msg.content || (msg.url ?? ""),
    BodyForAgent: body,
    CommandBody: body,
    ...resolvedMediaPayload,
    From: fromLabel,
    To: toLabel,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    SenderName: msg.senderName || undefined,
    SenderId: msg.senderId,
    ChatType: chatType,
    ConversationLabel: conversationLabel,
    Timestamp: msg.timestamp,
    MessageSid: msg.messageId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: toLabel,
    ...(msg.isGroup ? { GroupSubject: msg.groupName ?? peerId } : {}),
  });

  // ---- Dispatch AI reply ----
  await dispatchInboundReplyWithBase({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload: OutboundReplyPayload) => {
      await deliverFormattedTextWithAttachments({
        payload,
        send: async ({ text }) => {
          await sendReply(replyTarget, text);
          statusSink?.({ lastOutboundAt: Date.now() });
        },
      });
    },
    onRecordError: (err) => {
      log.error(`[${accountId}] failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      log.error(`[${accountId}] socket-chat ${info.kind} reply failed: ${String(err)}`);
    },
  });
}
