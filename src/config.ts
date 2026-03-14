import type { SocketChatAccountConfig, SocketChatTopLevelConfig } from "./config-schema.js";

export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_API_BASE_URL = "https://shellbot.opendevelop.tech";

/**
 * openclaw 配置的最小接口，仅包含 shellbot-chat 相关字段
 */
export type CoreConfig = {
  channels?: {
    "shellbot-chat"?: SocketChatTopLevelConfig;
  };
};

export type ResolvedSocketChatAccount = {
  accountId: string;
  apiKey: string | undefined;
  apiBaseUrl: string | undefined;
  name: string | undefined;
  enabled: boolean;
  config: SocketChatAccountConfig;
};

/**
 * 从配置中获取指定 accountId 的原始 config 对象
 */
function getRawAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): SocketChatAccountConfig {
  const top = cfg.channels?.["shellbot-chat"] ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 顶层字段即 default 账号
    const { accounts: _accounts, ...rest } = top;
    return rest as SocketChatAccountConfig;
  }
  return (top.accounts?.[accountId] ?? {}) as SocketChatAccountConfig;
}

/**
 * 解析指定账号的完整配置
 */
export function resolveSocketChatAccount(
  cfg: CoreConfig,
  accountId: string = DEFAULT_ACCOUNT_ID,
): ResolvedSocketChatAccount {
  const raw = getRawAccountConfig(cfg, accountId);
  // 顶层 apiKey/apiBaseUrl 作为 default 账号 fallback
  const top = cfg.channels?.["shellbot-chat"] ?? {};
  const apiKey =
    raw.apiKey?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? top.apiKey?.trim() : undefined);
  const apiBaseUrl =
    raw.apiBaseUrl?.trim() ||
    (accountId === DEFAULT_ACCOUNT_ID ? top.apiBaseUrl?.trim() : undefined) ||
    DEFAULT_API_BASE_URL;

  return {
    accountId,
    apiKey,
    apiBaseUrl,
    name: raw.name,
    enabled: raw.enabled !== false,
    config: raw,
  };
}

/**
 * 列出配置中所有账号 ID
 */
export function listSocketChatAccountIds(cfg: CoreConfig): string[] {
  const top = cfg.channels?.["shellbot-chat"];
  if (!top) return [];
  const named = Object.keys(top.accounts ?? {});
  // 检查顶层是否有 apiKey（即 default 账号被配置了）
  const hasDefault = Boolean(top.apiKey?.trim());
  if (hasDefault && !named.includes(DEFAULT_ACCOUNT_ID)) {
    return [DEFAULT_ACCOUNT_ID, ...named];
  }
  if (named.length > 0 && !hasDefault) {
    return named;
  }
  if (hasDefault && named.includes(DEFAULT_ACCOUNT_ID)) {
    return named;
  }
  return [DEFAULT_ACCOUNT_ID];
}

/**
 * 返回默认账号 ID
 */
export function resolveDefaultSocketChatAccountId(cfg: CoreConfig): string {
  const ids = listSocketChatAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * 规范化 accountId（去空格、小写）
 */
export function normalizeAccountId(id: string | undefined): string {
  return (id ?? DEFAULT_ACCOUNT_ID).trim().toLowerCase() || DEFAULT_ACCOUNT_ID;
}

/**
 * 判断账号是否已配置（只需 apiKey 存在，apiBaseUrl 有默认值）
 */
export function isSocketChatAccountConfigured(account: ResolvedSocketChatAccount): boolean {
  return Boolean(account.apiKey);
}

// ---- Config 写入辅助函数 ----

/**
 * 启用或禁用某账号
 */
export function setSocketChatAccountEnabled(params: {
  cfg: CoreConfig;
  accountId: string;
  enabled: boolean;
}): CoreConfig {
  const { cfg, accountId, enabled } = params;
  const top = cfg.channels?.["shellbot-chat"] ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "shellbot-chat": { ...top, enabled },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "shellbot-chat": {
        ...top,
        accounts: {
          ...top.accounts,
          [accountId]: { ...(top.accounts?.[accountId] ?? {}), enabled },
        },
      },
    },
  };
}

/**
 * 删除某账号配置
 */
export function deleteSocketChatAccount(params: {
  cfg: CoreConfig;
  accountId: string;
}): CoreConfig {
  const { cfg, accountId } = params;
  const top = { ...(cfg.channels?.["shellbot-chat"] ?? {}) };
  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 清除顶层凭证字段
    delete (top as Record<string, unknown>).apiKey;
    delete (top as Record<string, unknown>).apiBaseUrl;
    delete (top as Record<string, unknown>).enabled;
  } else {
    const accounts = { ...(top.accounts ?? {}) };
    delete accounts[accountId];
    top.accounts = accounts;
  }
  return {
    ...cfg,
    channels: { ...cfg.channels, "shellbot-chat": top },
  };
}

/**
 * 写入账号 apiKey/apiBaseUrl/name
 */
export function applySocketChatAccountConfig(params: {
  cfg: CoreConfig;
  accountId: string;
  apiKey: string;
  apiBaseUrl?: string;
  name?: string;
}): CoreConfig {
  const { cfg, accountId, apiKey, apiBaseUrl, name } = params;
  const top = cfg.channels?.["shellbot-chat"] ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "shellbot-chat": {
          ...top,
          apiKey,
          ...(apiBaseUrl ? { apiBaseUrl } : {}),
          ...(name ? { name } : {}),
          enabled: true,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "shellbot-chat": {
        ...top,
        accounts: {
          ...top.accounts,
          [accountId]: {
            ...(top.accounts?.[accountId] ?? {}),
            apiKey,
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
            ...(name ? { name } : {}),
            enabled: true,
          },
        },
      },
    },
  };
}
