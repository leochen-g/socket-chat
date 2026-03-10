import { z } from "zod";

/**
 * channels.socket-chat 账号配置 Schema
 *
 * 在 openclaw 配置文件（~/.openclaw/config.yaml）中对应：
 *
 * channels:
 *   socket-chat:
 *     apiKey: "your-api-key"
 *     apiBaseUrl: "https://your-server.com"
 *     enabled: true
 *     dmPolicy: "pairing"  # pairing | open | allowlist
 *     allowFrom: []
 *
 * 多账号：
 *   channels:
 *     socket-chat:
 *       accounts:
 *         work:
 *           apiKey: "..."
 *           apiBaseUrl: "..."
 */
export const SocketChatAccountConfigSchema = z.object({
  /** API Key，用于获取 MQTT 连接信息 */
  apiKey: z.string().optional(),
  /** 后端服务 base URL，例如 https://example.com */
  apiBaseUrl: z.string().optional(),
  /** 账号显示名称 */
  name: z.string().optional(),
  /** 是否启用此账号 */
  enabled: z.boolean().optional(),
  /** DM 安全策略 */
  dmPolicy: z.enum(["pairing", "open", "allowlist"]).optional(),
  /** 允许触发 AI 的发送者 ID 列表（DM 用） */
  allowFrom: z.array(z.string()).optional(),
  /** 默认发消息目标（contactId 或 group:groupId） */
  defaultTo: z.string().optional(),
  /** 群组消息是否需要 @提及 bot 才触发 */
  requireMention: z.boolean().optional(),
  /**
   * 群组访问策略（第一层：哪些群允许触发 AI）
   *   - "open"（默认）：bot 所在所有群均可触发
   *   - "allowlist"：仅 groups 列表中的群可触发
   *   - "disabled"：禁止所有群消息触发 AI
   */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  /**
   * 允许触发 AI 的群 ID 列表（第一层群级白名单）
   * groupPolicy="allowlist" 时生效；groupPolicy="open" 时忽略
   * 示例：["R:10804599808581977", "R:xxx"]
   */
  groups: z.array(z.string()).optional(),
  /**
   * 群内允许触发 AI 的发送者 ID 列表（第二层 sender 级白名单）
   * 不配置或为空则允许群内所有成员触发（受 requireMention 约束）
   */
  groupAllowFrom: z.array(z.string()).optional(),
  /** 媒体文件大小上限（MB）。未配置时使用框架全局默认值 */
  mediaMaxMb: z.number().optional(),
  /** MQTT 连接配置缓存 TTL（秒），默认 300 */
  mqttConfigTtlSec: z.number().optional(),
  /** MQTT 重连最大次数，默认 10 */
  maxReconnectAttempts: z.number().optional(),
  /** MQTT 重连基础延迟（毫秒），默认 2000，指数退避 */
  reconnectBaseDelayMs: z.number().optional(),
});

export type SocketChatAccountConfig = z.infer<typeof SocketChatAccountConfigSchema>;

/** 顶层 channels.socket-chat 配置（包含 accounts 多账号支持） */
export const SocketChatTopLevelConfigSchema = SocketChatAccountConfigSchema.extend({
  accounts: z.record(z.string(), SocketChatAccountConfigSchema).optional(),
});

export type SocketChatTopLevelConfig = z.infer<typeof SocketChatTopLevelConfigSchema>;
