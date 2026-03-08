import type { MqttClient, IPublishPacket } from "mqtt";
import mqtt from "mqtt";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { fetchMqttConfigCached, invalidateMqttConfigCache } from "./api.js";
import { handleInboundMessage } from "./inbound.js";
import type { ResolvedSocketChatAccount } from "./config.js";
import type { SocketChatInboundMessage, SocketChatMqttConfig, SocketChatStatusPatch } from "./types.js";
import { buildTextPayload, sendSocketChatMessage } from "./outbound.js";

const MAX_RECONNECT_ATTEMPTS_DEFAULT = 10;
const RECONNECT_BASE_DELAY_MS_DEFAULT = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;

type LogSink = NonNullable<ChannelGatewayContext["log"]>;

// ---------------------------------------------------------------------------
// 活跃连接注册表（供 outbound 查找当前 MQTT client）
// ---------------------------------------------------------------------------
const activeClients = new Map<string, MqttClient>();
const activeMqttConfigs = new Map<string, SocketChatMqttConfig>();

export function getActiveMqttClient(accountId: string): MqttClient | null {
  return activeClients.get(accountId) ?? null;
}

export function getActiveMqttConfig(accountId: string): SocketChatMqttConfig | null {
  return activeMqttConfigs.get(accountId) ?? null;
}

function setActiveMqttClient(accountId: string, client: MqttClient): void {
  activeClients.set(accountId, client);
}

function setActiveMqttConfig(accountId: string, config: SocketChatMqttConfig): void {
  activeMqttConfigs.set(accountId, config);
}

export function clearActiveMqttSession(accountId: string): void {
  const client = activeClients.get(accountId);
  client?.end(true);
  activeClients.delete(accountId);
  activeMqttConfigs.delete(accountId);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function buildMqttUrl(mqttConfig: SocketChatMqttConfig, useTls: boolean): string {
  const protocol = useTls ? "mqtts" : "mqtt";
  return `${protocol}://${mqttConfig.host}:${mqttConfig.port}`;
}

function parseInboundMessage(raw: Buffer | string): SocketChatInboundMessage | null {
  try {
    const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
    const obj = JSON.parse(str) as unknown;
    if (!obj || typeof obj !== "object") return null;
    const m = obj as Record<string, unknown>;
    if (
      typeof m.content !== "string" ||
      typeof m.robotId !== "string" ||
      typeof m.senderId !== "string" ||
      typeof m.messageId !== "string"
    ) {
      return null;
    }
    return {
      content: m.content,
      robotId: m.robotId,
      senderId: m.senderId,
      senderName: typeof m.senderName === "string" ? m.senderName : m.senderId,
      isGroup: m.isGroup === true,
      groupId: typeof m.groupId === "string" ? m.groupId : undefined,
      groupName: typeof m.groupName === "string" ? m.groupName : undefined,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      messageId: m.messageId,
    };
  } catch {
    return null;
  }
}

function backoffDelay(attempt: number, baseMs: number): number {
  const delay = Math.min(baseMs * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return delay * (0.9 + Math.random() * 0.2);
}

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 核心 Monitor 循环
// ---------------------------------------------------------------------------

/**
 * 启动 MQTT 监听循环，支持：
 *  - 自动拉取远端 MQTT 配置（带缓存）
 *  - 自动重连 + 指数退避
 *  - 注册活跃 client 供 outbound 发消息
 *  - AbortSignal 优雅停止
 */
export async function monitorSocketChatProviderWithRegistry(params: {
  account: ResolvedSocketChatAccount;
  accountId: string;
  ctx: ChannelGatewayContext<ResolvedSocketChatAccount>;
  log: LogSink;
}): Promise<void> {
  const { account, accountId, ctx, log } = params;
  const { abortSignal } = ctx;
  const maxReconnects = account.config.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS_DEFAULT;
  const reconnectBaseMs = account.config.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS_DEFAULT;
  const useTls = account.config.useTls ?? false;
  const mqttConfigTtlMs = (account.config.mqttConfigTtlSec ?? 300) * 1000;

  let reconnectAttempts = 0;

  const setStatus = (patch: SocketChatStatusPatch): void => {
    ctx.setStatus({ accountId, ...patch } as Parameters<typeof ctx.setStatus>[0]);
  };

  setStatus({ running: true, lastStartAt: Date.now() });

  try {
    while (!abortSignal.aborted) {
      // 1. 拉取 MQTT 配置
      let mqttConfig: SocketChatMqttConfig;
      try {
        mqttConfig = await fetchMqttConfigCached({
          apiBaseUrl: account.apiBaseUrl!,
          apiKey: account.apiKey!,
          ttlMs: mqttConfigTtlMs,
        });
        setActiveMqttConfig(accountId, mqttConfig);
        log.info(`[${accountId}] MQTT config OK, host=${mqttConfig.host}:${mqttConfig.port}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[${accountId}] failed to fetch MQTT config: ${message}`);
        setStatus({ lastError: message });
        reconnectAttempts++;
        if (reconnectAttempts > maxReconnects) {
          log.error(`[${accountId}] max reconnect attempts (${maxReconnects}) reached`);
          break;
        }
        setStatus({ reconnectAttempts });
        await waitMs(backoffDelay(reconnectAttempts, reconnectBaseMs), abortSignal);
        continue;
      }

      // 2. 建立 MQTT 连接
      const mqttUrl = buildMqttUrl(mqttConfig, useTls);
      log.info(`[${accountId}] connecting to ${mqttUrl} (clientId=${mqttConfig.clientId})`);

      const client = mqtt.connect(mqttUrl, {
        clientId: mqttConfig.clientId,
        username: mqttConfig.username,
        password: mqttConfig.password,
        clean: true,
        reconnectPeriod: 0,   // 禁用 mqtt.js 内置重连，由外层循环管理
        connectTimeout: 15_000,
        keepalive: 60,
      });

      setActiveMqttClient(accountId, client);

      // 等待连接关闭（正常关闭或错误都会 resolve）
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          log.info(`[${accountId}] abort signal, disconnecting`);
          client.end(true);
          resolve();
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        client.on("connect", () => {
          reconnectAttempts = 0;
          setStatus({
            connected: true,
            reconnectAttempts: 0,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          log.info(`[${accountId}] connected, subscribing to ${mqttConfig.reciveTopic}`);

          client.subscribe(mqttConfig.reciveTopic, (err: Error | null) => {
            if (err) {
              log.error(`[${accountId}] subscribe error: ${err}, ${err.message}`);
              client.end(true);
            } else {
              log.info(`[${accountId}] subscribed to ${mqttConfig.reciveTopic}`);
            }
          });
        });

        client.on("message", (topic: string, rawPayload: Buffer, _packet: IPublishPacket) => {
          if (topic !== mqttConfig.reciveTopic) return;
          setStatus({ lastEventAt: Date.now(), lastInboundAt: Date.now() });

          const msg = parseInboundMessage(rawPayload);
          if (!msg) {
            log.warn(`[${accountId}] unparseable message on ${topic}`);
            return;
          }
          // 跳过机器人自己的回声消息
          if (msg.robotId === mqttConfig.robotId && msg.senderId === mqttConfig.robotId) {
            return;
          }

          log.info(
            `[${accountId}] inbound msg ${msg.messageId} from ${msg.senderId}` +
            (msg.isGroup ? ` in group ${msg.groupId}` : ""),
          );

          void handleInboundMessage({
            msg,
            accountId,
            ctx,
            log,
            sendReply: async (to: string, text: string) => {
              const payload = buildTextPayload(to, text);
              await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
            },
          }).catch((e: unknown) => {
            log.error(
              `[${accountId}] handleInboundMessage error: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        });

        client.on("error", (err: Error) => {
          log.warn(`[${accountId}] MQTT error: ${err.message}`);
          setStatus({ lastError: err.message });
        });

        client.on("close", () => {
          setStatus({ connected: false, lastDisconnect: new Date().toISOString() });
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        });
      });

      // 清理注册表
      activeClients.delete(accountId);

      if (abortSignal.aborted) break;

      // 3. 重连退避
      reconnectAttempts++;
      if (reconnectAttempts > maxReconnects) {
        log.error(`[${accountId}] max reconnect attempts (${maxReconnects}) reached, giving up`);
        break;
      }
      // 清除 MQTT config 缓存，下次重连时重新拉取（token 可能已过期）
      invalidateMqttConfigCache({ apiBaseUrl: account.apiBaseUrl!, apiKey: account.apiKey! });
      const delay = backoffDelay(reconnectAttempts, reconnectBaseMs);
      log.info(
        `[${accountId}] reconnect ${reconnectAttempts}/${maxReconnects} in ${Math.round(delay)}ms`,
      );
      setStatus({ reconnectAttempts });
      await waitMs(delay, abortSignal);
    }
  } finally {
    clearActiveMqttSession(accountId);
    setStatus({ running: false, connected: false, lastStopAt: Date.now() });
    log.info(`[${accountId}] monitor stopped`);
  }
}
