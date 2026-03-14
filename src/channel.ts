import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk";
import {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
  applySocketChatAccountConfig,
  deleteSocketChatAccount,
  isSocketChatAccountConfigured,
  listSocketChatAccountIds,
  normalizeAccountId,
  resolveDefaultSocketChatAccountId,
  resolveSocketChatAccount,
  setSocketChatAccountEnabled,
  type CoreConfig,
  type ResolvedSocketChatAccount,
} from "./config.js";
import { probeSocketChatAccount } from "./probe.js";
import {
  buildTextPayload,
  looksLikeSocketChatTargetId,
  normalizeSocketChatTarget,
  sendSocketChatMessage,
  socketChatOutbound,
} from "./outbound.js";
import {
  getActiveMqttClient,
  getActiveMqttConfig,
  monitorSocketChatProviderWithRegistry,
} from "./mqtt-client.js";

// ---------------------------------------------------------------------------
// ChannelPlugin 实现
// ---------------------------------------------------------------------------

export const socketChatPlugin: ChannelPlugin<ResolvedSocketChatAccount> = {
  // -------------------------------------------------------------------------
  // 身份标识
  // -------------------------------------------------------------------------
  id: "shellbot-chat",

  meta: {
    id: "shellbot-chat",
    label: "Shellbot Chat",
    selectionLabel: "Shellbot Chat (MQTT plugin)",
    docsPath: "/channels/shellbot-chat",
    docsLabel: "shellbot-chat",
    blurb: "MQTT-based IM bridge; configure an API key to connect.",
    order: 90,
    quickstartAllowFrom: true,
  },

  // -------------------------------------------------------------------------
  // 能力声明
  // -------------------------------------------------------------------------
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,       // 支持图片（type: 2）
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true, // MQTT 不适合流式输出，等 AI 回复完整后再发
  },

  // -------------------------------------------------------------------------
  // 配置 Schema
  // -------------------------------------------------------------------------
  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        apiKey: { type: "string" },
        apiBaseUrl: { type: "string" },
        name: { type: "string" },
        enabled: { type: "boolean" },
        dmPolicy: { type: "string", enum: ["pairing", "open", "allowlist"] },
        allowFrom: { type: "array", items: { type: "string" } },
        defaultTo: { type: "string" },
        requireMention: { type: "boolean" },
        mqttConfigTtlSec: { type: "number" },
        maxReconnectAttempts: { type: "number" },
        reconnectBaseDelayMs: { type: "number" },
        accounts: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              apiKey: { type: "string" },
              apiBaseUrl: { type: "string" },
              name: { type: "string" },
              enabled: { type: "boolean" },
              dmPolicy: { type: "string", enum: ["pairing", "open", "allowlist"] },
              allowFrom: { type: "array", items: { type: "string" } },
              defaultTo: { type: "string" },
              requireMention: { type: "boolean" },
              mqttConfigTtlSec: { type: "number" },
              maxReconnectAttempts: { type: "number" },
              reconnectBaseDelayMs: { type: "number" },
            },
          },
        },
      },
    },
    uiHints: {
      apiKey: { label: "API Key", sensitive: true, help: "用于获取 MQTT 连接配置的 API Key" },
      apiBaseUrl: { label: "API Base URL", help: "后端服务地址，留空使用默认值 https://api-bot.aibotk.com" },
      dmPolicy: { label: "私信策略", help: "pairing=需配对, open=任意人, allowlist=白名单" },
      allowFrom: { label: "允许来源", help: "允许触发 AI 的发送者 ID 列表" },
      requireMention: { label: "群消息需@提及", help: "群组消息是否必须@提及机器人才触发" },
      mqttConfigTtlSec: { label: "MQTT 配置缓存时间（秒）", advanced: true },
      maxReconnectAttempts: { label: "最大重连次数", advanced: true },
      reconnectBaseDelayMs: { label: "重连基础延迟（毫秒）", advanced: true },
    },
  },

  // -------------------------------------------------------------------------
  // 账号配置管理
  // -------------------------------------------------------------------------
  config: {
    listAccountIds: (cfg) => listSocketChatAccountIds(cfg as CoreConfig),

    resolveAccount: (cfg, accountId) =>
      resolveSocketChatAccount(cfg as CoreConfig, accountId ?? DEFAULT_ACCOUNT_ID),

    defaultAccountId: (cfg) => resolveDefaultSocketChatAccountId(cfg as CoreConfig),

    isConfigured: (account) => isSocketChatAccountConfigured(account),

    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isSocketChatAccountConfigured(account),
    }),

    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveSocketChatAccount(cfg as CoreConfig, accountId ?? DEFAULT_ACCOUNT_ID);
      return account.config.allowFrom ?? [];
    },

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((e) => String(e).trim())
        .filter(Boolean)
        .map((e) => e.replace(/^shellbot-chat:/i, "").toLowerCase()),

    resolveDefaultTo: ({ cfg, accountId }) => {
      const account = resolveSocketChatAccount(cfg as CoreConfig, accountId ?? DEFAULT_ACCOUNT_ID);
      return account.config.defaultTo?.trim() || undefined;
    },

    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setSocketChatAccountEnabled({ cfg: cfg as CoreConfig, accountId, enabled }),

    deleteAccount: ({ cfg, accountId }) =>
      deleteSocketChatAccount({ cfg: cfg as CoreConfig, accountId }),
  },

  // -------------------------------------------------------------------------
  // 配对（pairing）
  // -------------------------------------------------------------------------
  pairing: {
    idLabel: "socketChatUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(shellbot-chat|sc):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      // 找到有活跃 MQTT 连接的账号发送配对批准通知
      // 优先用 default 账号，fallback 到任意有活跃连接的账号
      const accountIds = listSocketChatAccountIds(cfg as CoreConfig);
      let targetAccountId = DEFAULT_ACCOUNT_ID;
      for (const aid of accountIds) {
        if (getActiveMqttClient(aid)) {
          targetAccountId = aid;
          break;
        }
      }
      const client = getActiveMqttClient(targetAccountId);
      const mqttConfig = getActiveMqttConfig(targetAccountId);
      if (!client || !mqttConfig) return;
      const payload = buildTextPayload(id, "You have been approved to chat with this assistant.");
      await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
    },
  },

  // -------------------------------------------------------------------------
  // 安全策略
  // -------------------------------------------------------------------------
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const usesAccountPath = Boolean(
        (cfg as CoreConfig).channels?.["shellbot-chat"]?.accounts?.[resolvedId],
      );
      const basePath = usesAccountPath
        ? `channels.shellbot-chat.accounts.${resolvedId}.`
        : "channels.shellbot-chat.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: `Run: openclaw channels pair shellbot-chat <userId>`,
        normalizeEntry: (raw) => raw.replace(/^(shellbot-chat|sc):/i, ""),
      };
    },

    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (!account.config.allowFrom?.length && account.config.dmPolicy === "open") {
        warnings.push(
          "- shellbot-chat: dmPolicy=\"open\" allows any sender to trigger AI. " +
          "Consider setting dmPolicy=\"pairing\" or configuring allowFrom.",
        );
      }
      return warnings;
    },
  },

  // -------------------------------------------------------------------------
  // 群组策略
  // -------------------------------------------------------------------------
  groups: {
    resolveRequireMention: ({ cfg, accountId }) => {
      const account = resolveSocketChatAccount(cfg as CoreConfig, accountId ?? DEFAULT_ACCOUNT_ID);
      // 默认群消息需要 @提及才触发
      return account.config.requireMention !== false;
    },
    resolveToolPolicy: () => undefined,
  },

  // -------------------------------------------------------------------------
  // 消息目标规范化
  // -------------------------------------------------------------------------
  messaging: {
    normalizeTarget: normalizeSocketChatTarget,
    targetResolver: {
      looksLikeId: looksLikeSocketChatTargetId,
      hint: "<contactId|group:groupId|group:groupId@userId1,userId2>",
    },
  },

  // -------------------------------------------------------------------------
  // 出站发送
  // -------------------------------------------------------------------------
  outbound: socketChatOutbound,

  // -------------------------------------------------------------------------
  // 状态管理
  // -------------------------------------------------------------------------
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      reconnectAttempts: 0,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastEventAt: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },

    collectStatusIssues: (snapshots): ChannelStatusIssue[] => {
      const issues: ChannelStatusIssue[] = [];
      for (const snap of snapshots) {
        issues.push(...collectStatusIssuesFromLastError("shellbot-chat", [snap]));
        if (!snap.configured) {
          issues.push({
            channel: "shellbot-chat",
            accountId: snap.accountId,
            kind: "config",
            message: "shellbot-chat account is not configured (missing apiKey).",
            fix: "Run: openclaw channels add shellbot-chat",
          });
        }
      }
      return issues;
    },

    buildChannelSummary: ({ snapshot }) =>
      buildBaseChannelStatusSummary(snapshot),

    probeAccount: async ({ account, timeoutMs }) =>
      probeSocketChatAccount({ account, timeoutMs }),

    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = isSocketChatAccountConfigured(account);
      const accountWithConfigured = { ...account, configured };
      const base = buildBaseAccountStatusSnapshot({ account: accountWithConfigured, runtime, probe });
      return {
        ...base,
        // 补充 probe 信息到 snapshot
        probe,
        ...(probe && typeof probe === "object" && "host" in probe
          ? { baseUrl: `${(probe as { host?: string }).host}:${(probe as { port?: string }).port}` }
          : {}),
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },

  // -------------------------------------------------------------------------
  // Gateway：启动 MQTT 监听
  // -------------------------------------------------------------------------
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      if (!isSocketChatAccountConfigured(account)) {
        ctx.log?.error?.(
          `[${account.accountId}] shellbot-chat not configured (missing apiKey)`,
        );
        return;
      }

      ctx.log?.info?.(`[${account.accountId}] starting shellbot-chat MQTT provider`);

      return monitorSocketChatProviderWithRegistry({
        account,
        accountId: account.accountId,
        ctx,
        log: ctx.log ?? {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });
    },

    logoutAccount: async ({ accountId }) => {
      const client = getActiveMqttClient(accountId);
      client?.end(true);
      return { cleared: true, loggedOut: true };
    },
  },

  // -------------------------------------------------------------------------
  // 配置变更热重载
  // -------------------------------------------------------------------------
  reload: {
    configPrefixes: ["channels.shellbot-chat"],
  },

  // -------------------------------------------------------------------------
  // CLI setup 向导
  // -------------------------------------------------------------------------
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

    applyAccountConfig: ({ cfg, accountId, input }) => {
      const apiKey = (input.token ?? "").trim();
      const apiBaseUrl = (input.httpUrl ?? "").trim() || undefined;
      return applySocketChatAccountConfig({
        cfg: cfg as CoreConfig,
        accountId,
        apiKey,
        apiBaseUrl,
        name: input.name,
      });
    },

    validateInput: ({ input }) => {
      if (!input.token?.trim()) {
        return "shellbot-chat requires --token <apiKey>";
      }
      return null;
    },
  },

  // -------------------------------------------------------------------------
  // Agent prompt 提示词（告诉 AI 如何使用该 channel）
  // -------------------------------------------------------------------------
  agentPrompt: {
    messageToolHints: () => [
      "- shellbot-chat: to send to a group, use target format `group:<groupId>`. " +
        "To @mention users in a group: `group:<groupId>@<userId1>,<userId2>`.",
      "- shellbot-chat: to send an image, provide a public HTTP URL as the media parameter.",
      "- shellbot-chat: direct messages use the sender's contactId as the target.",
    ],
  },
};
