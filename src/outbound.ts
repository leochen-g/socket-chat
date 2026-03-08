import type { MqttClient } from "mqtt";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { getActiveMqttClient, getActiveMqttConfig } from "./mqtt-client.js";
import type { SocketChatMqttConfig, SocketChatOutboundPayload } from "./types.js";

/**
 * 解析 outbound "to" 字符串，得到发送目标
 *
 * 格式约定：
 *   - 私聊：contactId，例如 "wxid_abc123"
 *   - 群聊：以 "group:" 前缀，例如 "group:roomid_xxx"
 *   - 群聊带 @：以 "group:roomid_xxx@wxid_a,wxid_b"（@ 后面逗号分隔 mentionIds）
 */
export function parseSocketChatTarget(to: string): Omit<SocketChatOutboundPayload, "messages"> {
  const trimmed = to.trim();

  if (trimmed.startsWith("group:")) {
    const withoutPrefix = trimmed.slice("group:".length);
    const atIdx = withoutPrefix.indexOf("@");
    if (atIdx !== -1) {
      const groupId = withoutPrefix.slice(0, atIdx);
      const mentionIds = withoutPrefix
        .slice(atIdx + 1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return { isGroup: true, groupId, mentionIds };
    }
    return { isGroup: true, groupId: withoutPrefix };
  }

  return { isGroup: false, contactId: trimmed };
}

/**
 * 规范化 outbound 目标字符串（去掉前后空格，去掉 socket-chat: 前缀）
 */
export function normalizeSocketChatTarget(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^socket-chat:/i, "")
    .trim();
  return trimmed || undefined;
}

/**
 * 判断字符串是否像一个 socket-chat 原生 ID
 * wxid_xxx / roomid_xxx 格式，或带 group: 前缀
 */
export function looksLikeSocketChatTargetId(s: string): boolean {
  return /^(wxid_|roomid_|group:)/.test(s.trim());
}

/**
 * 构建纯文本发送 payload
 */
export function buildTextPayload(
  to: string,
  text: string,
  opts: { mentionIds?: string[] } = {},
): SocketChatOutboundPayload {
  const base = parseSocketChatTarget(to);
  const mentionIds =
    opts.mentionIds ?? (base.isGroup ? base.mentionIds : undefined);
  return {
    ...base,
    mentionIds: mentionIds?.length ? mentionIds : undefined,
    messages: [{ type: 1, content: text }],
  };
}

/**
 * 构建图片发送 payload（可附带文字 caption）
 */
export function buildMediaPayload(
  to: string,
  imageUrl: string,
  caption?: string,
): SocketChatOutboundPayload {
  const base = parseSocketChatTarget(to);
  const messages: SocketChatOutboundPayload["messages"] = [];
  if (caption?.trim()) {
    messages.push({ type: 1, content: caption });
  }
  messages.push({ type: 2, url: imageUrl });
  return { ...base, messages };
}

/**
 * 通过已连接的 MQTT client 发送出站消息
 */
export async function sendSocketChatMessage(params: {
  mqttClient: MqttClient;
  mqttConfig: SocketChatMqttConfig;
  payload: SocketChatOutboundPayload;
}): Promise<{ messageId: string }> {
  const { mqttClient, mqttConfig, payload } = params;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    mqttClient.publish(mqttConfig.sendTopic, body, { qos: 1 }, (err?: Error) => {
      if (err) {
        reject(new Error(`MQTT publish failed: ${err.message}`));
        return;
      }
      // 平台不返回 messageId，用本地时间戳生成一个
      resolve({ messageId: `sc-${Date.now()}` });
    });
  });
}

// ---------------------------------------------------------------------------
// ChannelOutboundAdapter 实现
// ---------------------------------------------------------------------------

/**
 * socket-chat 出站适配器。
 *
 * 通过注册表查找当前账号的活跃 MQTT client 发送消息：
 *   - sendText：发送纯文字
 *   - sendMedia：优先发图片（type:2），无 mediaUrl 时退化为纯文字
 *   - resolveTarget：规范化目标地址（strip socket-chat: 前缀）
 */
export const socketChatOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4096,

  resolveTarget: ({ to }) => {
    const normalized = to ? normalizeSocketChatTarget(to) : undefined;
    if (!normalized) {
      return { ok: false, error: new Error(`Invalid socket-chat target: "${to}"`) };
    }
    return { ok: true, to: normalized };
  },

  sendText: async ({ to, text, accountId }) => {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const client = getActiveMqttClient(resolvedAccountId);
    const mqttConfig = getActiveMqttConfig(resolvedAccountId);

    if (!client || !mqttConfig) {
      throw new Error(
        `[socket-chat] No active MQTT connection for account "${resolvedAccountId}". ` +
        "Is the gateway running?",
      );
    }

    const payload = buildTextPayload(to, text);
    const result = await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
    return { channel: "socket-chat", messageId: result.messageId };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
    const client = getActiveMqttClient(resolvedAccountId);
    const mqttConfig = getActiveMqttConfig(resolvedAccountId);

    if (!client || !mqttConfig) {
      throw new Error(
        `[socket-chat] No active MQTT connection for account "${resolvedAccountId}".`,
      );
    }

    // 有图片 URL 时发图片（可附带 caption），否则退化为纯文字
    if (mediaUrl) {
      const payload = buildMediaPayload(to, mediaUrl, text);
      const result = await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
      return { channel: "socket-chat", messageId: result.messageId };
    }

    const payload = buildTextPayload(to, text);
    const result = await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
    return { channel: "socket-chat", messageId: result.messageId };
  },
};
