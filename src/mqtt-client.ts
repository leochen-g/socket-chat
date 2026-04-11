import type { MqttClient, IPublishPacket } from "mqtt";
import mqtt from "mqtt";
import { fetchMqttConfigCached, invalidateMqttConfigCache } from "./api.js";
import { handleSocketChatInbound } from "./inbound.js";
import type { CoreConfig, ResolvedSocketChatAccount } from "./config.js";
import type {
  SocketChatInboundMessage,
  SocketChatMqttConfig,
  SocketChatOutboundPayload,
  SocketChatStatusPatch,
} from "./types.js";
import { parseSocketChatTarget, sendSocketChatMessage } from "./outbound.js";

const MAX_RECONNECT_ATTEMPTS_DEFAULT = 10;
const RECONNECT_BASE_DELAY_MS_DEFAULT = 2000;
const RECONNECT_MAX_DELAY_MS = 60_000;

type LogSink = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
};

// ---------------------------------------------------------------------------
// Active connection registry (used by outbound to find the current MQTT client)
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
// Helpers
// ---------------------------------------------------------------------------

function buildMqttUrl(mqttConfig: SocketChatMqttConfig): string {
  return `${mqttConfig.host}:${mqttConfig.port}`;
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
      isGroupMention: m.isGroupMention === true,
      groupId: typeof m.groupId === "string" ? m.groupId : undefined,
      groupName: typeof m.groupName === "string" ? m.groupName : undefined,
      timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
      messageId: m.messageId,
      type: typeof m.type === "string" ? m.type : undefined,
      url: typeof m.url === "string" ? m.url : undefined,
      mediaInfo:
        m.mediaInfo && typeof m.mediaInfo === "object" && !Array.isArray(m.mediaInfo)
          ? (m.mediaInfo as Record<string, unknown>)
          : undefined,
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
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Core monitor loop
// ---------------------------------------------------------------------------

/**
 * Start the MQTT monitoring loop with:
 * - Remote MQTT config fetch (with TTL cache)
 * - Auto-reconnect with exponential backoff
 * - Active client registry for outbound sends
 * - AbortSignal-based graceful shutdown
 */
export async function monitorSocketChatProviderWithRegistry(params: {
  account: ResolvedSocketChatAccount;
  accountId: string;
  config: CoreConfig;
  abortSignal: AbortSignal;
  log: LogSink;
  statusSink: (patch: SocketChatStatusPatch) => void;
}): Promise<void> {
  const { account, accountId, config, abortSignal, log, statusSink } = params;
  const maxReconnects = account.config.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS_DEFAULT;
  const reconnectBaseMs = account.config.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS_DEFAULT;
  const mqttConfigTtlMs = (account.config.mqttConfigTtlSec ?? 300) * 1000;

  let reconnectAttempts = 0;

  statusSink({ running: true, lastStartAt: Date.now() });

  try {
    while (!abortSignal.aborted) {
      // 1. Fetch MQTT config
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
        statusSink({ lastError: message });
        reconnectAttempts++;
        if (reconnectAttempts > maxReconnects) {
          log.error(`[${accountId}] max reconnect attempts (${maxReconnects}) reached`);
          break;
        }
        statusSink({ reconnectAttempts });
        await waitMs(backoffDelay(reconnectAttempts, reconnectBaseMs), abortSignal);
        continue;
      }

      // 2. Establish MQTT connection
      const mqttUrl = buildMqttUrl(mqttConfig);
      log.info(`[${accountId}] connecting to ${mqttUrl} (clientId=${mqttConfig.clientId})`);

      const client = mqtt.connect(mqttUrl, {
        clientId: mqttConfig.clientId,
        username: mqttConfig.username,
        password: mqttConfig.password,
        clean: true,
        reconnectPeriod: 0, // disable mqtt.js auto-reconnect; managed by outer loop
        connectTimeout: 15_000,
        keepalive: 60,
      });

      setActiveMqttClient(accountId, client);

      // Wait until connection closes (normally or on error)
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          log.info(`[${accountId}] abort signal, disconnecting`);
          client.end(true);
          resolve();
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });

        client.on("connect", () => {
          reconnectAttempts = 0;
          statusSink({
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
          statusSink({ lastEventAt: Date.now(), lastInboundAt: Date.now() });

          const msg = parseInboundMessage(rawPayload);
          if (!msg) {
            log.warn(`[${accountId}] unparseable message on ${topic}`);
            return;
          }
          // Skip the bot's own echo messages
          if (msg.robotId === mqttConfig.robotId && msg.senderId === mqttConfig.robotId) {
            return;
          }

          log.info(
            `[${accountId}] inbound msg ${msg.messageId} from ${msg.senderId}` +
              (msg.isGroup ? ` in group ${msg.groupId}` : ""),
          );

          void handleSocketChatInbound({
            msg,
            accountId,
            config,
            log,
            statusSink,
            sendReply: async (to: string, text: string) => {
              const base = parseSocketChatTarget(to);
              const payload: SocketChatOutboundPayload = {
                ...base,
                messages: [{ type: 1, content: text }],
              };
              await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
            },
          }).catch((e: unknown) => {
            log.error(
              `[${accountId}] handleSocketChatInbound error: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
        });

        client.on("error", (err: Error) => {
          log.warn(`[${accountId}] MQTT error: ${err.message}`);
          statusSink({ lastError: err.message });
        });

        client.on("close", () => {
          statusSink({ connected: false, lastDisconnect: new Date().toISOString() });
          abortSignal.removeEventListener("abort", onAbort);
          resolve();
        });
      });

      // Remove from registry
      activeClients.delete(accountId);

      if (abortSignal.aborted) break;

      // 3. Reconnect with backoff
      reconnectAttempts++;
      if (reconnectAttempts > maxReconnects) {
        log.error(`[${accountId}] max reconnect attempts (${maxReconnects}) reached, giving up`);
        break;
      }
      // Invalidate config cache so next reconnect re-fetches (token may have expired)
      invalidateMqttConfigCache({ apiBaseUrl: account.apiBaseUrl!, apiKey: account.apiKey! });
      const delay = backoffDelay(reconnectAttempts, reconnectBaseMs);
      log.info(
        `[${accountId}] reconnect ${reconnectAttempts}/${maxReconnects} in ${Math.round(delay)}ms`,
      );
      statusSink({ reconnectAttempts });
      await waitMs(delay, abortSignal);
    }
  } finally {
    clearActiveMqttSession(accountId);
    statusSink({ running: false, connected: false, lastStopAt: Date.now() });
    log.info(`[${accountId}] monitor stopped`);
  }
}
