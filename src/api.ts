import type { SocketChatMqttConfig } from "./types.js";

/**
 * 调用后端 API 获取 MQTT 连接配置
 * GET {apiBaseUrl}/api/openclaw/chat/config?apikey={apiKey}
 */
export async function fetchMqttConfig(params: {
  apiBaseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}): Promise<SocketChatMqttConfig> {
  const { apiBaseUrl, apiKey, timeoutMs = 10_000 } = params;
  const url = `${apiBaseUrl.replace(/\/$/, "")}/openapi/v1/openclaw/chat/config?apiKey=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `fetchMqttConfig: HTTP ${res.status} from ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      );
    }

    const data = (await res.json()) as unknown;
    validateMqttConfig(data);
    return data as SocketChatMqttConfig;
  } finally {
    clearTimeout(timer);
  }
}

function validateMqttConfig(data: unknown): asserts data is SocketChatMqttConfig {
  if (!data || typeof data !== "object") {
    throw new Error("fetchMqttConfig: response is not an object");
  }
  const d = data as Record<string, unknown>;
  const required: (keyof SocketChatMqttConfig)[] = [
    "host",
    "port",
    "username",
    "password",
    "clientId",
    "reciveTopic",
    "sendTopic",
  ];
  for (const key of required) {
    if (!d[key]) {
      throw new Error(`fetchMqttConfig: missing or invalid field "${key}" in response`);
    }
  }
}

/**
 * 简单的 TTL 缓存，避免每次重连都重新请求 config
 */
type CacheEntry = {
  config: SocketChatMqttConfig;
  fetchedAt: number;
};

const configCache = new Map<string, CacheEntry>();

export async function fetchMqttConfigCached(params: {
  apiBaseUrl: string;
  apiKey: string;
  ttlMs?: number;
  timeoutMs?: number;
}): Promise<SocketChatMqttConfig> {
  const { apiBaseUrl, apiKey, ttlMs = 300_000, timeoutMs } = params;
  const cacheKey = `${apiBaseUrl}::${apiKey}`;
  const cached = configCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.config;
  }
  const config = await fetchMqttConfig({ apiBaseUrl, apiKey, timeoutMs });
  configCache.set(cacheKey, { config, fetchedAt: Date.now() });
  return config;
}

/** 清除指定账号的缓存（例如重连时强制刷新） */
export function invalidateMqttConfigCache(params: {
  apiBaseUrl: string;
  apiKey: string;
}): void {
  const cacheKey = `${params.apiBaseUrl}::${params.apiKey}`;
  configCache.delete(cacheKey);
}
