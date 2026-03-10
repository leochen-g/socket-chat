// Socket Chat inbound/outbound 消息类型定义

/**
 * MQTT 收到的入站消息格式（reciveTopic）
 */
export type SocketChatInboundMessage = {
  /** 消息文字内容 */
  content: string;
  /** 机器人 ID（robotId，即本 bot 账号标识） */
  robotId: string;
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName: string;
  /** 是否是群消息 */
  isGroup: boolean;
  /** 群 ID（isGroup=true 时存在） */
  groupId?: string;
  /** 群名称（isGroup=true 时存在） */
  groupName?: string;
  /** 是否在群中 @了机器人（由平台精确计算，优先于文本匹配） */
  isGroupMention?: boolean;
  /** 11 位时间戳（毫秒） */
  timestamp: number;
  /** 消息唯一 ID */
  messageId: string;
  /** 消息类型：文字 / 图片 / 视频 / 文件 / 语音 / 名片 / h5链接 / 视频号 / 位置 / 历史记录 */
  type?: string;
  /** 媒体文件 URL（图片/视频/文件/语音等，OSS 链接或 base64） */
  url?: string;
  /** 额外媒体元数据（视频号、名片、h5链接等结构化信息） */
  mediaInfo?: Record<string, unknown>;
};

/**
 * 单条发送消息体
 * type: 1=文字, 2=纯图片
 */
export type SocketChatOutboundMessage =
  | { type: 1; content: string }
  | { type: 2; url: string };

/**
 * MQTT 发送的出站消息格式（sendTopic）
 */
export type SocketChatOutboundPayload = {
  /** 是否发给群 */
  isGroup: boolean;
  /** 群 ID（isGroup=true 时传） */
  groupId?: string;
  /** 私聊用户 ID（isGroup=false 时传） */
  contactId?: string;
  /** 群组中 @提及的用户 ID 列表 */
  mentionIds?: string[];
  /** 消息列表（支持多条） */
  messages: SocketChatOutboundMessage[];
};

/**
 * 从 GET /api/openclaw/chat/config 获取的 MQTT 连接配置
 */
export type SocketChatMqttConfig = {
  host: string;
  port: string;
  username: string;
  password: string;
  clientId: string;
  reciveTopic: string;
  sendTopic: string;
  /** 机器人自身的 ID（用于识别是否是自己发出的消息） */
  robotId: string;
  /** 当前用户/账号 ID */
  userId: string;
};

/**
 * 出站目标解析结果
 */
export type SocketChatTarget =
  | { isGroup: false; contactId: string }
  | { isGroup: true; groupId: string; mentionIds?: string[] };

/**
 * MQTT 运行时状态 patch（传给 ctx.setStatus）
 */
export type SocketChatStatusPatch = {
  accountId?: string;
  running?: boolean;
  connected?: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: string | null;
  lastEventAt?: number | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  reconnectAttempts?: number;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  mode?: string;
};
