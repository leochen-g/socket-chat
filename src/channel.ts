import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createAccountStatusSink,
  createChatChannelPlugin,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type ChannelStatusIssue,
} from "./runtime-api.js";
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
  buildSocketChatMediaPayload,
  looksLikeSocketChatTargetId,
  normalizeSocketChatTarget,
  parseSocketChatTarget,
  sendSocketChatMessage,
  sendSocketChatText,
} from "./outbound.js";
import {
  clearActiveMqttSession,
  getActiveMqttClient,
  getActiveMqttConfig,
  monitorSocketChatProviderWithRegistry,
} from "./mqtt-client.js";
import { getSocketChatRuntime } from "./runtime.js";
import type { SocketChatOutboundPayload } from "./types.js";

// ---------------------------------------------------------------------------
// ChannelPlugin implementation
// ---------------------------------------------------------------------------

export const socketChatPlugin: ChannelPlugin<ResolvedSocketChatAccount> =
  createChatChannelPlugin<ResolvedSocketChatAccount>({
    base: {
      // -----------------------------------------------------------------------
      // Identity
      // -----------------------------------------------------------------------
      id: "socket-chat",

      meta: {
        id: "socket-chat",
        label: "Socket Chat",
        selectionLabel: "Socket Chat (MQTT plugin)",
        docsPath: "/channels/socket-chat",
        docsLabel: "socket-chat",
        blurb: "MQTT-based IM bridge; configure an API key to connect.",
        order: 90,
        quickstartAllowFrom: true,
      },

      // -----------------------------------------------------------------------
      // Capabilities
      // -----------------------------------------------------------------------
      capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
        reactions: false,
        threads: false,
        polls: false,
        nativeCommands: false,
        blockStreaming: true,
      },

      // -----------------------------------------------------------------------
      // Config schema
      // -----------------------------------------------------------------------
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
          apiKey: { label: "API Key", sensitive: true, help: "API Key for fetching MQTT connection config" },
          apiBaseUrl: { label: "API Base URL", help: "Backend service URL; defaults to https://api-bot.aibotk.com" },
          dmPolicy: { label: "DM Policy", help: "pairing=require approval, open=anyone, allowlist=whitelist" },
          allowFrom: { label: "Allow From", help: "Sender IDs allowed to trigger AI" },
          requireMention: { label: "Require @mention in groups", help: "Whether group messages must @mention the bot" },
          mqttConfigTtlSec: { label: "MQTT config cache TTL (seconds)", advanced: true },
          maxReconnectAttempts: { label: "Max reconnect attempts", advanced: true },
          reconnectBaseDelayMs: { label: "Reconnect base delay (ms)", advanced: true },
        },
      },

      // -----------------------------------------------------------------------
      // Account config management
      // -----------------------------------------------------------------------
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
          const account = resolveSocketChatAccount(
            cfg as CoreConfig,
            accountId ?? DEFAULT_ACCOUNT_ID,
          );
          return account.config.allowFrom ?? [];
        },

        formatAllowFrom: ({ allowFrom }) =>
          allowFrom
            .map((e) => String(e).trim())
            .filter(Boolean)
            .map((e) => e.replace(/^socket-chat:/i, "").toLowerCase()),

        resolveDefaultTo: ({ cfg, accountId }) => {
          const account = resolveSocketChatAccount(
            cfg as CoreConfig,
            accountId ?? DEFAULT_ACCOUNT_ID,
          );
          return account.config.defaultTo?.trim() || undefined;
        },

        setAccountEnabled: ({ cfg, accountId, enabled }) =>
          setSocketChatAccountEnabled({ cfg: cfg as CoreConfig, accountId, enabled }),

        deleteAccount: ({ cfg, accountId }) =>
          deleteSocketChatAccount({ cfg: cfg as CoreConfig, accountId }),
      },

      // -----------------------------------------------------------------------
      // Groups
      // -----------------------------------------------------------------------
      groups: {
        resolveRequireMention: ({ cfg, accountId }) => {
          const account = resolveSocketChatAccount(
            cfg as CoreConfig,
            accountId ?? DEFAULT_ACCOUNT_ID,
          );
          return account.config.requireMention !== false;
        },
        resolveToolPolicy: () => undefined,
      },

      // -----------------------------------------------------------------------
      // Messaging target
      // -----------------------------------------------------------------------
      messaging: {
        normalizeTarget: normalizeSocketChatTarget,
        targetResolver: {
          looksLikeId: looksLikeSocketChatTargetId,
          hint: "<contactId|group:groupId|group:groupId|userId1,userId2>",
        },
      },

      // -----------------------------------------------------------------------
      // Status
      // -----------------------------------------------------------------------
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
            issues.push(...collectStatusIssuesFromLastError("socket-chat", [snap]));
            if (!snap.configured) {
              issues.push({
                channel: "socket-chat",
                accountId: snap.accountId,
                kind: "config",
                message: "socket-chat account is not configured (missing apiKey).",
                fix: "Run: openclaw channels add socket-chat",
              });
            }
          }
          return issues;
        },

        buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),

        probeAccount: async ({ account, timeoutMs }) =>
          probeSocketChatAccount({ account, timeoutMs }),

        buildAccountSnapshot: ({ account, runtime, probe }) => {
          const configured = isSocketChatAccountConfigured(account);
          const accountWithConfigured = { ...account, configured };
          const base = buildBaseAccountStatusSnapshot({ account: accountWithConfigured, runtime, probe });
          return {
            ...base,
            probe,
            ...(probe && typeof probe === "object" && "host" in probe
              ? {
                  baseUrl: `${(probe as { host?: string }).host}:${(probe as { port?: string }).port}`,
                }
              : {}),
            lastInboundAt: runtime?.lastInboundAt ?? null,
            lastOutboundAt: runtime?.lastOutboundAt ?? null,
          };
        },
      },

      // -----------------------------------------------------------------------
      // Gateway: start MQTT monitor
      // -----------------------------------------------------------------------
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;

          if (!isSocketChatAccountConfigured(account)) {
            ctx.log?.error?.(
              `[${account.accountId}] socket-chat not configured (missing apiKey)`,
            );
            return;
          }

          ctx.log?.info?.(`[${account.accountId}] starting socket-chat MQTT provider`);

          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });

          return monitorSocketChatProviderWithRegistry({
            account,
            accountId: account.accountId,
            config: ctx.cfg as CoreConfig,
            abortSignal: ctx.abortSignal,
            log: ctx.log ?? { info: () => {}, warn: () => {}, error: () => {} },
            statusSink,
          });
        },

        logoutAccount: async ({ accountId }) => {
          clearActiveMqttSession(accountId);
          return { cleared: true, loggedOut: true };
        },
      },

      // -----------------------------------------------------------------------
      // Hot reload
      // -----------------------------------------------------------------------
      reload: {
        configPrefixes: ["channels.socket-chat"],
      },

      // -----------------------------------------------------------------------
      // CLI setup wizard
      // -----------------------------------------------------------------------
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
            return "socket-chat requires --token <apiKey>";
          }
          return null;
        },
      },

      // -----------------------------------------------------------------------
      // Agent prompt hints
      // -----------------------------------------------------------------------
      agentPrompt: {
        messageToolHints: () => [
          "- socket-chat: to send to a group, use target format `group:<groupId>` (groupId may contain @, e.g. `group:17581395450@chatroom`). " +
            "To @mention users in a group: `group:<groupId>|<userId1>,<userId2>`.",
          "- socket-chat: to send an image, provide a public HTTP URL as the media parameter.",
          "- socket-chat: direct messages use the sender's contactId as the target.",
        ],
      },
    },

    // -------------------------------------------------------------------------
    // Pairing
    // -------------------------------------------------------------------------
    pairing: {
      idLabel: "socketChatUserId",
      normalizeAllowEntry: (entry) => entry.replace(/^(socket-chat|sc):/i, ""),
      notifyApproval: async ({ cfg, id }) => {
        // Find an account with an active MQTT connection to deliver the approval notification.
        // Prefer the default account; fall back to any account with an active connection.
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
        const base = parseSocketChatTarget(id);
        const payload: SocketChatOutboundPayload = {
          ...base,
          messages: [{ type: 1, content: "You have been approved to chat with this assistant." }],
        };
        await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
      },
    },

    // -------------------------------------------------------------------------
    // Security
    // -------------------------------------------------------------------------
    security: {
      resolveDmPolicy: ({ cfg, accountId, account }) => {
        const resolvedId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
        const usesAccountPath = Boolean(
          (cfg as CoreConfig).channels?.["socket-chat"]?.accounts?.[resolvedId],
        );
        const basePath = usesAccountPath
          ? `channels.socket-chat.accounts.${resolvedId}.`
          : "channels.socket-chat.";
        return {
          policy: account.config.dmPolicy ?? "pairing",
          allowFrom: account.config.allowFrom ?? [],
          policyPath: `${basePath}dmPolicy`,
          allowFromPath: basePath,
          approveHint: `Run: openclaw channels pair socket-chat <userId>`,
          normalizeEntry: (raw) => raw.replace(/^(socket-chat|sc):/i, ""),
        };
      },

      collectWarnings: ({ account }) => {
        const warnings: string[] = [];
        if (!account.config.allowFrom?.length && account.config.dmPolicy === "open") {
          warnings.push(
            '- socket-chat: dmPolicy="open" allows any sender to trigger AI. ' +
              'Consider setting dmPolicy="pairing" or configuring allowFrom.',
          );
        }
        return warnings;
      },
    },

    // -------------------------------------------------------------------------
    // Outbound
    // -------------------------------------------------------------------------
    outbound: {
      base: {
        deliveryMode: "block" as const,
        chunker: (text: string, limit: number) =>
          getSocketChatRuntime().channel.text.chunkMarkdownText(text, limit),
        chunkerMode: "markdown" as const,
        textChunkLimit: 4096,
      },
      attachedResults: {
        channel: "socket-chat",

        sendText: async ({ to, text, accountId: aid }) =>
          sendSocketChatText({ to, text, accountId: aid }),

        sendMedia: async ({ to, text, mediaUrl, accountId: aid }) => {
          const resolvedAccountId = aid ?? DEFAULT_ACCOUNT_ID;
          const client = getActiveMqttClient(resolvedAccountId);
          const mqttConfig = getActiveMqttConfig(resolvedAccountId);

          if (!client || !mqttConfig) {
            throw new Error(
              `[socket-chat] No active MQTT connection for account "${resolvedAccountId}".`,
            );
          }

          if (mediaUrl) {
            const payload = buildSocketChatMediaPayload(to, mediaUrl, text);
            const result = await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
            return { channel: "socket-chat", messageId: result.messageId };
          }

          return sendSocketChatText({ to, text, accountId: aid });
        },
      },
    },
  });
