import type { MqttClient } from "mqtt";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { getActiveMqttClient, getActiveMqttConfig } from "./mqtt-client.js";
import type { SocketChatMqttConfig, SocketChatOutboundPayload } from "./types.js";

/**
 * 解析 outbound "to" 字符串，得到发送目标
 *
 * 格式约定：
 *   - 私聊：contactId，例如 "wxid_abc123"
 *   - 群聊：以 "group:" 前缀，例如 "group:17581395450@chatroom"
 *   - 群聊带 mention：用 "|" 分隔 groupId 与 mentionIds，例如 "group:17581395450@chatroom|wxid_a,wxid_b"
 */
export function parseSocketChatTarget(to: string): Omit<SocketChatOutboundPayload, "messages"> {
  const trimmed = to.trim();

  if (trimmed.startsWith("group:")) {
    const withoutPrefix = trimmed.slice("group:".length);
    const pipeIdx = withoutPrefix.indexOf("|");
    if (pipeIdx !== -1) {
      const groupId = withoutPrefix.slice(0, pipeIdx);
      const mentionIds = withoutPrefix
        .slice(pipeIdx + 1)
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
 * socket-chat 的 chatId 格式不固定，任何非空字符串均视为原生 ID
 */
export function looksLikeSocketChatTargetId(s: string): boolean {
  return s.trim().length > 0;
}

/**
 * 构建文字消息 payload（纯函数，不发送）
 */
export function buildSocketChatTextPayload(
  to: string,
  text: string,
  opts?: { mentionIds?: string[] },
): SocketChatOutboundPayload {
  const base = parseSocketChatTarget(to);
  const mentionIds = opts?.mentionIds?.length ? opts.mentionIds : undefined;
  return { ...base, messages: [{ type: 1, content: text }], ...(mentionIds ? { mentionIds } : {}) };
}

/**
 * 构建图片发送 payload（可附带文字 caption）
 */
export function buildSocketChatMediaPayload(
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
// Shared outbound helper used by channel.ts and inbound.ts
// ---------------------------------------------------------------------------

/**
 * 通过活跃的 MQTT client 发送文字消息到指定目标
 */
export async function sendSocketChatText(params: {
  to: string;
  text: string;
  accountId?: string;
}): Promise<{ channel: string; messageId: string }> {
  const { to, text } = params;
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const client = getActiveMqttClient(resolvedAccountId);
  const mqttConfig = getActiveMqttConfig(resolvedAccountId);

  if (!client || !mqttConfig) {
    throw new Error(
      `[socket-chat] No active MQTT connection for account "${resolvedAccountId}". ` +
        "Is the gateway running?",
    );
  }

  const base = parseSocketChatTarget(to);
  const payload: SocketChatOutboundPayload = {
    ...base,
    messages: [{ type: 1, content: text }],
  };
  const result = await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
  return { channel: "socket-chat", messageId: result.messageId };
}
