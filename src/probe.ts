import { fetchMqttConfig } from "./api.js";
import type { ResolvedSocketChatAccount } from "./config.js";

export type SocketChatProbeResult = {
  ok: boolean;
  error?: string;
  host?: string;
  port?: string;
  robotId?: string;
  userId?: string;
  reciveTopic?: string;
  sendTopic?: string;
};

/**
 * 探测账号连通性：
 * 1. 调用 GET /api/openclaw/chat/config 验证 API key 有效性
 * 2. 返回获取到的连接信息摘要
 */
export async function probeSocketChatAccount(params: {
  account: ResolvedSocketChatAccount;
  timeoutMs: number;
}): Promise<SocketChatProbeResult> {
  const { account, timeoutMs } = params;

  if (!account.apiKey || !account.apiBaseUrl) {
    return { ok: false, error: "apiKey or apiBaseUrl not configured" };
  }

  try {
    const config = await fetchMqttConfig({
      apiBaseUrl: account.apiBaseUrl,
      apiKey: account.apiKey,
      timeoutMs,
    });
    return {
      ok: true,
      host: config.host,
      port: config.port,
      robotId: config.robotId,
      userId: config.userId,
      reciveTopic: config.reciveTopic,
      sendTopic: config.sendTopic,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
