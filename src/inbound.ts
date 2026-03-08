import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { resolveAllowlistMatchByCandidates, createNormalizedOutboundDeliverer } from "openclaw/plugin-sdk";
import { resolveSocketChatAccount, type CoreConfig } from "./config.js";
import type { ResolvedSocketChatAccount } from "./config.js";
import type { SocketChatInboundMessage } from "./types.js";

// ---------------------------------------------------------------------------
// 安全检查 — DM 访问控制
// ---------------------------------------------------------------------------

/**
 * 执行 DM 安全策略检查，返回是否允许此消息触发 AI。
 *
 * 策略：
 *   - "open"：任意发送者均可触发
 *   - "allowlist"：senderId 必须在 allowFrom 列表中
 *   - "pairing"（默认）：senderId 必须在 allowFrom 或 pairing 已批准列表中；
 *     否则发送配对请求消息并阻止本次触发
 *
 * 群组消息跳过 DM 策略检查（群组有独立的 requireMention 控制）。
 */
async function enforceDmAccess(params: {
  msg: SocketChatInboundMessage;
  accountId: string;
  account: ResolvedSocketChatAccount;
  ctx: ChannelGatewayContext<ResolvedSocketChatAccount>;
  log: LogSink;
  sendReply: (text: string) => Promise<void>;
}): Promise<boolean> {
  const { msg, accountId, account, ctx, log, sendReply } = params;
  const channelRuntime = ctx.channelRuntime!;

  // 群组消息不走 DM 策略
  if (msg.isGroup) {
    return true;
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";

  if (dmPolicy === "open") {
    return true;
  }

  // 读取配置中的静态 allowFrom 白名单
  const configAllowFrom = (account.config.allowFrom ?? []).map((e) =>
    e.replace(/^(socket-chat|sc):/i, "").toLowerCase(),
  );

  // 读取动态 pairing 已批准名单（存储在 ~/.openclaw/credentials/ 下）
  const pairingAllowFrom: string[] = await channelRuntime.pairing.readAllowFromStore({
    channel: "socket-chat",
    accountId,
  });

  // 合并两个白名单进行匹配
  const mergedAllowFrom = [
    ...configAllowFrom,
    ...pairingAllowFrom.map((e: string) => e.toLowerCase()),
  ];

  const senderId = msg.senderId.toLowerCase();
  const senderName = msg.senderName?.toLowerCase();
  const match = resolveAllowlistMatchByCandidates({
    allowList: mergedAllowFrom,
    candidates: [
      { value: senderId, source: "id" as const },
      ...(senderName ? [{ value: senderName, source: "name" as const }] : []),
    ],
  });

  // 通配符（"*"）直接放行
  if (mergedAllowFrom.includes("*") || match.allowed) {
    return true;
  }

  // allowlist 策略：不在白名单中，静默拒绝
  if (dmPolicy === "allowlist") {
    log.warn(
      `[${accountId}] blocked sender ${msg.senderId} (dmPolicy=allowlist, not in allowFrom)`,
    );
    return false;
  }

  // pairing 策略：创建配对请求，并向发送者发送提示
  try {
    const { code, created } = await channelRuntime.pairing.upsertPairingRequest({
      channel: "socket-chat",
      id: msg.senderId,
      accountId,
      meta: {
        senderName: msg.senderName || undefined,
      },
    });

    if (created) {
      log.info(
        `[${accountId}] pairing request created for ${msg.senderId} (code=${code})`,
      );
      const pairingMessage = channelRuntime.pairing.buildPairingReply({
        channel: "socket-chat",
        idLine: `Your Socket Chat user id: ${msg.senderId}`,
        code,
      });
      await sendReply(pairingMessage);
    }
  } catch (err) {
    log.warn(
      `[${accountId}] failed to create pairing request for ${msg.senderId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return false;
}

// ---------------------------------------------------------------------------
// 群组消息 @提及检查
// ---------------------------------------------------------------------------

/**
 * 检查群组消息是否需要 @提及 bot。
 * 从配置读取 requireMention，默认为 true（需要提及）。
 *
 * 提及检测：消息内容包含 robotId 即视为提及。
 */
function checkGroupMention(params: {
  msg: SocketChatInboundMessage;
  account: ResolvedSocketChatAccount;
  robotId: string;
  log: LogSink;
  accountId: string;
}): boolean {
  const { msg, account, robotId, log, accountId } = params;
  if (!msg.isGroup) return true;

  const requireMention = account.config.requireMention !== false; // 默认 true
  if (!requireMention) return true;

  // 检测消息中是否包含 robotId（简单 @提及）
  const mentioned =
    msg.content.includes(`@${robotId}`) ||
    msg.content.includes(robotId);

  if (!mentioned) {
    log.debug?.(
      `[${accountId}] group msg ${msg.messageId} skipped (requireMention=true, not mentioned)`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 主入站处理函数
// ---------------------------------------------------------------------------

type LogSink = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
};

/**
 * 处理 MQTT 入站消息：
 * 1. 安全策略检查（allowlist / pairing）
 * 2. 群组 @提及检查
 * 3. 路由 + 记录 session
 * 4. 派发 AI 回复
 */
export async function handleInboundMessage(params: {
  msg: SocketChatInboundMessage;
  accountId: string;
  ctx: ChannelGatewayContext<ResolvedSocketChatAccount>;
  log: LogSink;
  /** 发送文字回复给原始发送者（用于 pairing 提示消息） */
  sendReply: (to: string, text: string) => Promise<void>;
}): Promise<void> {
  const { msg, accountId, ctx, log, sendReply } = params;
  const channelRuntime = ctx.channelRuntime;

  if (!channelRuntime) {
    log.warn(`[socket-chat:${accountId}] channelRuntime not available — cannot dispatch AI reply`);
    return;
  }

  // 跳过空消息（媒体消息 content 可能为空，但有 url 时不跳过）
  if (!msg.content?.trim() && !msg.url) {
    log.debug?.(`[${accountId}] skip empty message ${msg.messageId}`);
    return;
  }

  // 解析当前账号配置（用于安全策略）
  const account = resolveSocketChatAccount(ctx.cfg as CoreConfig, accountId);

  // ---- 1. DM 安全策略检查 ----
  const replyTarget = msg.isGroup ? `group:${msg.groupId}` : msg.senderId;
  const allowed = await enforceDmAccess({
    msg,
    accountId,
    account,
    ctx,
    log,
    sendReply: (text) => sendReply(replyTarget, text),
  });
  if (!allowed) {
    return;
  }

  // ---- 2. 群组 @提及检查 ----
  // robotId 从 MQTT config 传入（由 mqtt-client.ts 调用时提供）
  // 此处从 msg.robotId 字段取（平台在每条消息中会带上 robotId）
  const mentionAllowed = checkGroupMention({
    msg,
    account,
    robotId: msg.robotId,
    log,
    accountId,
  });
  if (!mentionAllowed) {
    return;
  }

  const chatType = msg.isGroup ? "group" : "direct";
  const peerId = msg.isGroup ? (msg.groupId ?? msg.senderId) : msg.senderId;

  // 判断是否为媒体消息（图片/视频/文件等）
  const mediaUrl = msg.url && !msg.url.startsWith("data:") ? msg.url : undefined;
  // base64 内容不传给 agent（避免超长），仅标记 placeholder
  const isMediaMsg = !!msg.type && msg.type !== "文字";
  // BodyForAgent：媒体消息在 content 中已包含描述文字（如"【图片消息】\n下载链接：..."），直接使用
  const body = msg.content?.trim() || (isMediaMsg ? `<media:${msg.type}>` : "");

  // ---- 3. 路由 ----
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "socket-chat",
    accountId,
    peer: {
      kind: msg.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  log.debug?.(
    `[${accountId}] dispatch ${msg.messageId} from ${msg.senderId} → agent ${route.agentId}`,
  );

  // ---- 4. 构建 MsgContext ----
  const fromLabel = msg.isGroup
    ? `socket-chat:room:${peerId}`
    : `socket-chat:${msg.senderId}`;
  const toLabel = `socket-chat:${replyTarget}`;
  const conversationLabel = msg.isGroup
    ? (msg.groupName ?? peerId)
    : (msg.senderName || msg.senderId);

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    RawBody: msg.content || (msg.url ?? ""),
    BodyForAgent: body,
    CommandBody: body,
    ...(mediaUrl
      ? {
          MediaUrl: mediaUrl,
          MediaUrls: [mediaUrl],
          MediaPath: mediaUrl,
          // 尽量从 type 推断 MIME，否则留空由框架处理
          MediaType: msg.type === "图片" ? "image/jpeg" : msg.type === "视频" ? "video/mp4" : undefined,
        }
      : {}),
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
    Provider: "socket-chat",
    Surface: "socket-chat",
    OriginatingChannel: "socket-chat",
    OriginatingTo: toLabel,
    ...(msg.isGroup
      ? { GroupSubject: msg.groupName ?? peerId }
      : {}),
  });

  try {
    // ---- 5. 记录 session 元数据 ----
    const storePath = channelRuntime.session.resolveStorePath(undefined, {
      agentId: route.agentId,
    });
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err) => {
        log.error(`[${accountId}] failed updating session meta: ${String(err)}`);
      },
    });

    // 记录 inbound 活动
    channelRuntime.activity.record({
      channel: "socket-chat",
      accountId,
      direction: "inbound",
    });

    // ---- 6. 派发 AI 回复 ----
    // deliver 负责实际发送：框架当 originatingChannel === currentSurface 时
    // 不走 outbound adapter，直接调用此函数投递回复。
    const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
      const text = payload.text?.trim();
      if (!text) return;
      const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];
      const content = mediaUrl ? `${text}\n\nAttachment: ${mediaUrl}` : text;
      await sendReply(replyTarget, content);
    });

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: ctx.cfg,
      dispatcherOptions: {
        deliver: deliverReply,
        onError: (err, info) => {
          log.error(`[${accountId}] socket-chat ${info.kind} reply failed: ${String(err)}`);
        },
      },
    });

    // 记录 outbound 活动
    channelRuntime.activity.record({
      channel: "socket-chat",
      accountId,
      direction: "outbound",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[${accountId}] dispatch error for message ${msg.messageId}: ${message}`);
  }
}
