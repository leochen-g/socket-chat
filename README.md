# socket-chat OpenClaw Extension

通过 **MQTT** 协议与自定义 IM 系统对接的 OpenClaw channel plugin。

---

## 工作原理

```
IM 平台 ──MQTT──► reciveTopic ──► socket-chat plugin ──► OpenClaw AI
OpenClaw AI ──► socket-chat plugin ──MQTT──► sendTopic ──► IM 平台
```

1. 插件启动时，调用 `GET /api/openclaw/chat/config?apikey={apiKey}` 获取 MQTT 连接参数
2. 建立 MQTT 连接，订阅 `reciveTopic`
3. 收到消息后，通过 `channelRuntime` 派发给 AI agent
4. AI 回复通过 `outbound.sendText/sendMedia` 向 `sendTopic` 发布

---

## 安装

```bash
# 从 npm 安装
openclaw plugins install @openclaw-channel/socket-chat

# 或者本地开发时从路径安装
openclaw plugins install /path/to/socket-chat
```

---

## 通过 CLI 添加账号

apiKey 从微秘书平台[个人中心](https://wechat.aibotk.com/user/info)获取

```bash
openclaw channels add --channel socket-chat --token <apiKey>
```

---

## 配置

在 `~/.openclaw/config.yaml` 中添加：

```yaml
channels:
  socket-chat:
    apiKey: "your-api-key"
    enabled: true

    # DM（私聊）访问策略
    dmPolicy: "pairing"       # pairing | open | allowlist
    allowFrom: []             # DM 白名单（dmPolicy=allowlist/pairing 时生效）

    # 群组访问策略
    requireMention: true      # 群消息是否需要 @提及机器人
    groupPolicy: "open"       # open | allowlist | disabled（见下方说明）
    groups: []                # 允许的群 ID 列表（groupPolicy=allowlist 时生效）
    groupAllowFrom: []        # 群内允许触发 AI 的发送者 ID/昵称列表
```

### 群组访问控制

群消息经过**三层**依次检查，任意一层不通过则丢弃该消息：

#### 第一层：群级（哪些群允许触发 AI）

| `groupPolicy` | 行为 |
|--------------|------|
| `open`（默认）| bot 所在所有群均可触发 |
| `allowlist` | 仅 `groups` 列表中的群可触发；首次被拦截时向该群发一条提醒（进程内只发一次） |
| `disabled` | 禁止所有群消息触发 AI，静默丢弃 |

```yaml
channels:
  socket-chat:
    groupPolicy: allowlist
    groups:
      - "R:10804599808581977"
      - "R:another_group_id"
```

#### 第二层：sender 级（群内哪些人可以触发 AI）

`groupAllowFrom` 为空时不限制（允许群内所有成员）。支持按 `senderId` 或 `senderName` 匹配，大小写不敏感，支持通配符 `*`。

```yaml
channels:
  socket-chat:
    groupAllowFrom:
      - "wxid_123456"   # 按 senderId 精确匹配
      - "Alice"         # 按 senderName 匹配
      - "*"             # 允许所有成员
```

被拦截的 sender 静默丢弃，不向群发任何提示。

#### 第三层：@提及检查

`requireMention: true`（默认）时，群消息必须满足以下任意条件之一：
- 平台传来 `isGroupMention: true`
- 消息内容包含 `@{robotId}`

> **注意**：媒体消息（图片、视频等）无法携带 @，若平台侧开启了 `forwardMediaMsg`，
> 应在发布 MQTT 消息时主动将 `isGroupMention` 设为 `true`，避免被此层拦截。

### 多账号配置

```yaml
channels:
  socket-chat:
    accounts:
      work:
        apiKey: "api-key"
        enabled: true
      personal:
        apiKey: "api-key"
        enabled: true
```

### 可选高级配置

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `dmPolicy` | `pairing` | DM 访问策略：`pairing` / `open` / `allowlist` |
| `allowFrom` | `[]` | DM 白名单，senderId 或 senderName 列表 |
| `requireMention` | `true` | 群消息是否需要 @提及机器人 |
| `groupPolicy` | `open` | 群访问策略：`open` / `allowlist` / `disabled` |
| `groups` | `[]` | 允许的群 ID 列表（`groupPolicy=allowlist` 时生效） |
| `groupAllowFrom` | `[]` | 群内允许触发 AI 的发送者 ID/昵称列表，空=不限制 |
| `mqttConfigTtlSec` | `300` | MQTT 配置缓存时间（秒） |
| `maxReconnectAttempts` | `10` | MQTT 断线最大重连次数 |
| `reconnectBaseDelayMs` | `2000` | 重连基础延迟（毫秒，指数退避） |

---



## 消息格式

### 收到的 MQTT 消息（reciveTopic）

所有消息类型共有的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | string | 消息内容（文字消息为原文，媒体消息为格式化描述） |
| `robotId` | string | 机器人微信 ID |
| `senderId` | string | 发消息人微信 ID（wxid） |
| `senderName` | string | 发消息人昵称 |
| `isGroup` | boolean | 是否为群消息 |
| `groupId` | string \| undefined | 群 ID（仅群消息） |
| `groupName` | string \| undefined | 群名称（仅群消息） |
| `isGroupMention` | boolean | 是否在群中 @了机器人 |
| `timestamp` | number | 消息时间戳（13 位毫秒） |
| `messageId` | string | 消息 ID |
| `type` | string | 消息类型，见下方枚举 |
| `conversionId` | string | 会话 ID（私聊为 senderId，群聊为 groupId） |
| `conversionName` | string | 会话名称（私聊为昵称，群聊为群名） |
| `chatAlias` | string \| undefined | 发消息人在机器人通讯录中的备注 |
| `chatUserWeixin` | string | 发消息人的微信号（weixin 字段，可能为空） |
| `isMyself` | boolean | 是否为机器人自己发的消息 |
| `url` | string \| undefined | 媒体资源链接（OSS URL 或 base64，仅媒体消息携带） |
| `mediaInfo` | object \| undefined | 结构化媒体信息（名片、视频号、h5 链接携带） |

`type` 枚举值：`文字`、`图片`、`视频`、`文件`、`语音`、`名片`、`h5链接`、`视频号`、`位置`、`历史记录`。

文字消息示例：

```json
{
  "content": "消息内容",
  "robotId": "wxid_robot",
  "senderId": "wxid_user123",
  "senderName": "用户昵称",
  "isGroup": false,
  "isGroupMention": false,
  "timestamp": 1234567890123,
  "messageId": "uuid-xxx",
  "type": "文字",
  "conversionId": "wxid_user123",
  "conversionName": "用户昵称",
  "chatAlias": "同事小明",
  "chatUserWeixin": "",
  "isMyself": false
}
```

群消息（@提及）示例：

```json
{
  "content": "消息内容",
  "robotId": "wxid_robot",
  "senderId": "wxid_user123",
  "senderName": "用户昵称",
  "isGroup": true,
  "groupId": "roomid_xxx",
  "groupName": "工作群",
  "isGroupMention": true,
  "timestamp": 1234567890123,
  "messageId": "uuid-xxx",
  "type": "文字",
  "conversionId": "roomid_xxx",
  "conversionName": "工作群",
  "chatAlias": "",
  "chatUserWeixin": "",
  "isMyself": false
}
```

图片 / 视频 / 文件消息（已上传 OSS）：

```json
{
  "content": "【图片消息】\n文件名：img.jpg\n下载链接：https://oss.example.com/img.jpg",
  "robotId": "wxid_robot",
  "senderId": "wxid_user123",
  "senderName": "用户昵称",
  "isGroup": false,
  "isGroupMention": false,
  "timestamp": 1234567890123,
  "messageId": "uuid-xxx",
  "type": "图片",
  "conversionId": "wxid_user123",
  "conversionName": "用户昵称",
  "chatAlias": "",
  "chatUserWeixin": "",
  "isMyself": false,
  "url": "https://oss.example.com/img.jpg"
}
```

名片消息（携带 `mediaInfo`）：

```json
{
  "content": "【名片消息】\n联系人昵称：张三\n联系人ID：wxid_zhangsan",
  "type": "名片",
  "mediaInfo": {
    "name": "张三",
    "avatar": "https://...",
    "wxid": "wxid_zhangsan"
  }
}
```

视频号消息（携带 `mediaInfo`）：

```json
{
  "content": "【视频号消息】\n视频号昵称：xxx\n视频号简介：...\n视频号链接：https://...",
  "type": "视频号",
  "mediaInfo": {
    "nickname": "xxx",
    "coverUrl": "https://...",
    "avatar": "https://...",
    "desc": "视频号简介",
    "url": "https://...",
    "objectId": "...",
    "objectNonceId": "..."
  }
}
```

h5 链接消息（携带 `mediaInfo`）：

```json
{
  "content": "【链接消息】\n链接标题：xxx\n链接描述：...\n链接地址：https://...",
  "type": "h5链接",
  "mediaInfo": {
    "url": "https://...",
    "description": "链接描述",
    "imageUrl": "https://thumbnail...",
    "title": "链接标题"
  }
}
```

> 图片/视频等媒体消息会同时携带 `content`（格式化描述文字）和 `url`（资源链接）。若平台未配置 OSS，`url` 为 base64 字符串，插件会忽略 base64 内容，仅将 `content` 描述文字传给 AI agent。

#### 媒体消息处理逻辑

| 场景 | `content` | `url` | AI 收到的内容 |
|------|-----------|-------|--------------|
| 纯文字 | 消息文本 | — | 消息文本 |
| 图片（有 OSS URL） | 包含下载链接的描述 | HTTP URL | 描述文字 + `MediaUrl` 字段 |
| 图片（无 OSS，base64） | 包含 base64 的描述 | `data:image/...` | 仅描述文字（base64 被过滤） |
| 仅有 URL、无 content | — | HTTP URL | `<media:图片>` placeholder |

---

### 发送的 MQTT 消息（sendTopic）

```json
{
  "isGroup": false,
  "contactId": "wxid_user123",
  "messages": [
    { "type": 1, "content": "文字消息" }
  ]
}
```

群消息 + @提及：
```json
{
  "isGroup": true,
  "groupId": "roomid_xxx",
  "mentionIds": ["wxid_a", "wxid_b"],
  "messages": [
    { "type": 1, "content": "回复内容" },
    { "type": 2, "url": "https://example.com/image.jpg" }
  ]
}
```

---

## 发消息目标格式（openclaw message send）

| 格式 | 说明 |
|------|------|
| `wxid_xxx` | 私聊某用户 |
| `group:roomid_xxx` | 发到群组 |
| `group:roomid_xxx@wxid_a,wxid_b` | 发到群组并 @提及用户 |

```bash
openclaw message send "Hello" --channel socket-chat --to wxid_user123
openclaw message send "Hello group" --channel socket-chat --to group:roomid_xxx
```

---

## 项目结构

```
socket-chat/
├── index.ts              # 插件入口（register）
├── package.json          # 包配置，含 openclaw.extensions
├── tsconfig.json
└── src/
    ├── types.ts          # MQTT 消息类型定义
    ├── config-schema.ts  # Zod 配置 Schema
    ├── config.ts         # 账号配置解析 + 写入工具
    ├── api.ts            # GET /api/openclaw/chat/config 调用（带缓存）
    ├── outbound.ts       # 发送消息（buildPayload + sendSocketChatMessage）
    ├── inbound.ts        # 入站消息处理 → dispatch AI 回复
    ├── mqtt-client.ts    # MQTT 连接管理 + 自动重连 monitor 循环
    ├── probe.ts          # 账号连通性探测
    ├── runtime.ts        # PluginRuntime 单例
    └── channel.ts        # ChannelPlugin 主体（所有 adapter 实现）
```

---

## API 接口要求

后端需实现：

### `GET /openapi/v1/openclaw/chat/config?apikey={apiKey}`

**Response 200:**
```json
{
  "host": "mqtt.example.com",
  "port": "1883",
  "username": "mqttuser",
  "password": "mqttpass",
  "clientId": "openclaw-bot-001",
  "reciveTopic": "/im/botId/msg",
  "sendTopic": "/im/botId/send",
  "robotId": "wxid_bot",
  "userId": "user123"
}
```

所有字段均为必填字符串。
