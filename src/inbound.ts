import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import {
  resolveAllowlistMatchByCandidates,
  createNormalizedOutboundDeliverer,
  buildMediaPayload,
  resolveChannelMediaMaxBytes,
  detectMime,
} from "openclaw/plugin-sdk";
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
    e.replace(/^(shellbot-chat|sc):/i, "").toLowerCase(),
  );

  // 读取动态 pairing 已批准名单（存储在 ~/.openclaw/credentials/ 下）
  const pairingAllowFrom: string[] = await channelRuntime.pairing.readAllowFromStore({
    channel: "shellbot-chat",
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
      channel: "shellbot-chat",
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
        channel: "shellbot-chat",
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
// 群组访问控制 — 第一层（groupId 级别）+ 第二层（sender 级别）
// ---------------------------------------------------------------------------

/**
 * 记录已发送过"群未授权"提醒的群，键为 `${accountId}:${groupId}`。
 * 进程内只提醒一次，避免每条消息都重复发送。
 */
const notifiedGroups = new Set<string>();

/** 仅供测试使用：重置一次性提醒状态。 */
export function _resetNotifiedGroupsForTest(): void {
  notifiedGroups.clear();
}

/**
 * 规范化群/发送者 ID，去除前缀、空格、转小写，便于白名单对比。
 */
function normalizeSocketChatId(raw: string): string {
  return raw.replace(/^(shellbot-chat|sc):/i, "").trim().toLowerCase();
}

/**
 * 第一层：检查当前群是否被允许触发 AI。
 *
 * - groupPolicy="open"（默认）：所有群均可触发
 * - groupPolicy="allowlist"：仅 groups 列表中的群可触发，不在列表的群收到一次提醒
 * - groupPolicy="disabled"：禁止所有群消息触发 AI
 *
 * 返回 `{ allowed, notify }`:
 *   - allowed=false + notify=true 表示首次拦截，调用方应发送提醒消息
 *   - allowed=false + notify=false 表示已提醒过，静默忽略
 */
function checkGroupAccess(params: {
  groupId: string;
  account: ResolvedSocketChatAccount;
  log: LogSink;
  accountId: string;
}): { allowed: boolean; notify: boolean } {
  const { groupId, account, log, accountId } = params;
  const groupPolicy = account.config.groupPolicy ?? "open";

  if (groupPolicy === "disabled") {
    log.info(`[${accountId}] group msg blocked (groupPolicy=disabled)`);
    return { allowed: false, notify: false };
  }

  if (groupPolicy === "open") {
    return { allowed: true, notify: false };
  }

  // allowlist：检查 groupId 是否在 groups 名单中
  const groups = (account.config.groups ?? []).map(normalizeSocketChatId);
  if (groups.length === 0) {
    log.info(`[${accountId}] group ${groupId} blocked (groupPolicy=allowlist, groups is empty)`);
    return { allowed: false, notify: false };
  }

  const normalizedGroupId = normalizeSocketChatId(groupId);
  if (groups.includes("*") || groups.includes(normalizedGroupId)) {
    return { allowed: true, notify: false };
  }

  log.info(`[${accountId}] group ${groupId} not in groups allowlist (groupPolicy=allowlist)`);

  // 判断是否需要发送一次性提醒
  const notifyKey = `${accountId}:${groupId}`;
  if (notifiedGroups.has(notifyKey)) {
    return { allowed: false, notify: false };
  }
  notifiedGroups.add(notifyKey);
  return { allowed: false, notify: true };
}

/**
 * 第二层：检查群内发送者是否被允许触发 AI。
 *
 * 仅当 groupAllowFrom 非空时生效；为空则允许群内所有成员。
 */
function checkGroupSenderAccess(params: {
  senderId: string;
  senderName: string | undefined;
  account: ResolvedSocketChatAccount;
  log: LogSink;
  accountId: string;
}): boolean {
  const { senderId, senderName, account, log, accountId } = params;
  const groupAllowFrom = (account.config.groupAllowFrom ?? []).map(normalizeSocketChatId);

  // 未配置 sender 白名单 → 不限制
  if (groupAllowFrom.length === 0) return true;
  if (groupAllowFrom.includes("*")) return true;

  const normalizedSenderId = normalizeSocketChatId(senderId);
  const normalizedSenderName = senderName ? senderName.trim().toLowerCase() : undefined;

  const allowed =
    groupAllowFrom.includes(normalizedSenderId) ||
    (normalizedSenderName !== undefined && groupAllowFrom.includes(normalizedSenderName));

  if (!allowed) {
    log.info(
      `[${accountId}] group sender ${senderId} not in groupAllowFrom`,
    );
  }
  return allowed;
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

  // 优先使用平台传来的精确判断（on-claw-message.js 已计算好 isMention）
  // fallback：检查消息内容中是否包含 @robotId（不做宽泛的 content.includes(robotId) 以避免误判）
  const mentioned =
    msg.isGroupMention === true ||
    msg.content.includes(`@${robotId}`);

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
 * 3. 媒体文件下载到本地
 * 4. 路由 + 记录 session
 * 5. 派发 AI 回复
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
    log.warn(`[shellbot-chat:${accountId}] channelRuntime not available — cannot dispatch AI reply`);
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

  // ---- 2. 群组访问控制（第一层：群级 + 第二层：sender 级）----
  if (msg.isGroup) {
    const groupId = msg.groupId ?? msg.senderId;

    // 第一层：groupId 是否在允许列表中
    const groupAccess = checkGroupAccess({ groupId, account, log, accountId });
    if (!groupAccess.allowed) {
      // if (groupAccess.notify) {
      //   await sendReply(
      //     `group:${groupId}`,
      //     `此群（${msg.groupName ?? groupId}）未获授权使用 AI 服务。如需开启，请联系管理员将群 ID "${groupId}" 加入 groups 配置。`,
      //   );
      // }
      return;
    }

    // 第二层：群内发送者是否被允许
    const senderAccessAllowed = checkGroupSenderAccess({
      senderId: msg.senderId,
      senderName: msg.senderName,
      account,
      log,
      accountId,
    });
    if (!senderAccessAllowed) return;
  }

  // ---- 3. 群组 @提及检查 ----
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
  const isMediaMsg = !!msg.type && msg.type !== "文字";
  // BodyForAgent：媒体消息在 content 中已包含描述文字（如"【图片消息】\n下载链接：..."），直接使用
  const body = msg.content?.trim() || (isMediaMsg ? `<media:${msg.type}>` : "");

  // ---- 3. 媒体文件本地化 ----
  // 将媒体 URL 下载到本地，让 agent 能直接读取文件而不依赖外部 URL 的可用性。
  // HTTP/HTTPS URL：通过 fetchRemoteMedia 下载；data: URL：直接解码 base64。
  let resolvedMediaPayload = {};
  const mediaUrl = msg.url?.trim();
  if (mediaUrl) {
    try {
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: ctx.cfg,
        resolveChannelLimitMb: ({ cfg }) =>
          (cfg as CoreConfig).channels?.["shellbot-chat"]?.mediaMaxMb,
        accountId,
      });

      let buffer: Buffer;
      let contentTypeHint: string | undefined;

      if (mediaUrl.startsWith("data:")) {
        // data URL：解析 MIME 和 base64 载荷
        const commaIdx = mediaUrl.indexOf(",");
        const meta = commaIdx > 0 ? mediaUrl.slice(5, commaIdx) : "";
        const base64Data = commaIdx > 0 ? mediaUrl.slice(commaIdx + 1) : "";
        contentTypeHint = meta.split(";")[0] || undefined;

        // 大小预检（base64 字节数 × 0.75 ≈ 原始字节数）
        const estimatedBytes = Math.ceil(base64Data.length * 0.75);
        if (maxBytes && estimatedBytes > maxBytes) {
          log.warn(
            `[${accountId}] base64 media too large for ${msg.messageId} (est. ${estimatedBytes} bytes, limit ${maxBytes})`,
          );
          throw new Error("base64 media exceeds maxBytes limit");
        }

        buffer = Buffer.from(base64Data, "base64");
      } else {
        // HTTP/HTTPS URL：通过网络下载
        const fetched = await channelRuntime.media.fetchRemoteMedia({
          url: mediaUrl,
          filePathHint: mediaUrl,
          maxBytes,
        });
        buffer = fetched.buffer;
        contentTypeHint = fetched.contentType;
      }

      const mime = await detectMime({
        buffer,
        headerMime: contentTypeHint,
        filePath: mediaUrl,
      });
      const saved = await channelRuntime.media.saveMediaBuffer(
        buffer,
        mime ?? contentTypeHint,
        "inbound",
        maxBytes,
      );
      resolvedMediaPayload = buildMediaPayload([
        { path: saved.path, contentType: saved.contentType },
      ]);
    } catch (err) {
      // 下载/解码失败不阻断消息处理，仍正常派发文字部分
      log.warn(
        `[${accountId}] media localization failed for ${msg.messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- 4. 路由 ----
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "shellbot-chat",
    accountId,
    peer: {
      kind: msg.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  log.debug?.(
    `[${accountId}] dispatch ${msg.messageId} from ${msg.senderId} → agent ${route.agentId}`,
  );

  // ---- 5. 构建 MsgContext ----
  const fromLabel = msg.isGroup
    ? `shellbot-chat:room:${peerId}`
    : `shellbot-chat:${msg.senderId}`;
  const toLabel = `shellbot-chat:${replyTarget}`;
  const conversationLabel = msg.isGroup
    ? (msg.groupName ?? peerId)
    : (msg.senderName || msg.senderId);

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
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
    Provider: "shellbot-chat",
    Surface: "shellbot-chat",
    OriginatingChannel: "shellbot-chat",
    OriginatingTo: toLabel,
    ...(msg.isGroup
      ? { GroupSubject: msg.groupName ?? peerId }
      : {}),
  });

  try {
    // ---- 6. 记录 session 元数据 ----
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
      channel: "shellbot-chat",
      accountId,
      direction: "inbound",
    });

    // ---- 7. 派发 AI 回复 ----
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
          log.error(`[${accountId}] shellbot-chat ${info.kind} reply failed: ${String(err)}`);
        },
      },
    });

    // 记录 outbound 活动
    channelRuntime.activity.record({
      channel: "shellbot-chat",
      accountId,
      direction: "outbound",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[${accountId}] dispatch error for message ${msg.messageId}: ${message}`);
  }
}
