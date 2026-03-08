# socket-chat 开发经验与注意事项

## 1. openclaw plugin-sdk API 签名

### status-helpers

这三个函数的签名容易踩坑，必须对照源码：

```ts
// ✅ 正确
buildBaseChannelStatusSummary(snapshot)
// ❌ 错误（没有 options 参数）
buildBaseChannelStatusSummary({ snapshot, includeMode: false })

// ✅ 正确：configured 必须挂在 account 上，不能作为顶层参数
const accountWithConfigured = { ...account, configured };
buildBaseAccountStatusSnapshot({ account: accountWithConfigured, runtime, probe })

// ✅ 正确：channel 在前，accounts 数组在后
collectStatusIssuesFromLastError("socket-chat", [snap])
// ❌ 错误（参数顺序反了）
collectStatusIssuesFromLastError(snap, "socket-chat")
```

### ChannelOutboundAdapter

feishu / matrix 把 outbound 提取到独立的 `outbound.ts` 文件并导出类型化对象，不要在 `ChannelPlugin` 里内联写匿名对象：

```ts
// outbound.ts
export const socketChatOutbound: ChannelOutboundAdapter = { ... };

// channel.ts
import { socketChatOutbound } from "./outbound.js";
export const socketChatPlugin: ChannelPlugin = {
  outbound: socketChatOutbound,  // 一行引用
};
```

`ChannelPlugin` 没有 `inspectAccount` 字段，不要添加。

---

## 2. Zod v4 的 z.record() 行为变化

Zod v4 中 `z.record(Schema)` 把 Schema 当作 **key** 的校验，而不是 value：

```ts
// ❌ Zod v4 中 key 校验会失败
z.record(SocketChatAccountConfigSchema)

// ✅ 必须显式传两个参数
z.record(z.string(), SocketChatAccountConfigSchema)
```

---

## 3. aedes MQTT broker 的 CJS 兼容

aedes 是 CJS 模块，ESM 项目中具名导入会报找不到：

```ts
// ❌ 报错：createBroker is not exported
import { createBroker } from "aedes";

// ✅ 用默认导入，再调用方法
import aedesModule from "aedes";
const broker = aedesModule.createBroker();
```

`@types/aedes` 包不存在，aedes 自带类型定义，直接用即可。

---

## 4. plugin 安装顺序

openclaw 启动时会校验 `channels.*` 中的 channel id 是否已注册。**必须先装插件，再写 channel 配置**，否则会报 `unknown channel id` 并阻塞所有 CLI 命令：

```
# 正确顺序
1. 创建 openclaw.plugin.json（id、channels、configSchema）
2. openclaw plugins install --link <path>
3. 重启 gateway
4. 再往 openclaw.json 写 channels.socket-chat 配置
```

`openclaw.plugin.json` 是 `plugins install` 的必要条件，缺少会报找不到 manifest。

---

## 5. default 账号的配置结构

socket-chat 的 `default` 账号直接读取 `channels.socket-chat` 顶层字段，**不是** `channels.socket-chat.accounts.default`：

```jsonc
// ✅ 正确：apiKey/apiBaseUrl 放顶层
"channels": {
  "socket-chat": {
    "apiKey": "mytest-key-001",
    "apiBaseUrl": "http://localhost:3000",
    "dmPolicy": "open",
    "allowFrom": ["*"]
  }
}

// ❌ 错误：放在 accounts.default 下 default 账号读不到
"channels": {
  "socket-chat": {
    "accounts": {
      "default": { "apiKey": "..." }
    }
  }
}
```

---

## 6. vitest 中避免拉取完整 plugin-sdk

`openclaw/plugin-sdk` 依赖链包含 `json5` 等在测试环境下无法加载的模块。在 `vitest.config.ts` 中用 alias 指向轻量 stub：

```ts
// vitest.config.ts
resolve: {
  alias: [
    {
      find: "openclaw/plugin-sdk",
      replacement: path.join(dir, "src", "__sdk-stub__.ts"),
    },
  ],
},
```

stub 只重新导出测试实际用到的内容：

```ts
// __sdk-stub__.ts
export { resolveAllowlistMatchByCandidates } from "../../openclaw/src/channels/allowlist-match.js";
export type { ChannelGatewayContext } from "../../openclaw/src/plugin-sdk/index.js";
```

---

## 7. 集成测试的隔离策略

集成测试用独立端口（`HTTP_PORT=13100`、`MQTT_PORT=11883`）启动 socket-server 子进程，与本地开发端口（3000/1883）完全隔离：

```ts
serverProcess = spawn("npx", ["tsx", serverEntry], {
  env: { ...process.env, HTTP_PORT: "13100", MQTT_PORT: "11883", SEED_API_KEY: "integration-test-key", ... },
});
await waitForServer(`http://localhost:13100/health`);
```

`waitForServer` 轮询 `/health`，避免 race condition。

---

## 8. dmPolicy 配置

| 值          | 行为                                   |
|-------------|---------------------------------------|
| `pairing`   | 需先执行 `openclaw channels pair` 配对 |
| `open`      | 任意发送者都能触发 AI                  |
| `allowlist` | 只有 `allowFrom` 列表中的 ID 能触发   |

本地调试推荐用 `dmPolicy: "open"` + `allowFrom: ["*"]`，省去配对步骤。

---

## 9. 入站媒体消息处理

wechaty-web-panel 在 `publishClawMessage` 中把处理好的媒体数据通过 MQTT 发给插件，payload 携带三个额外字段：

| 字段 | 说明 |
|------|------|
| `type` | 消息类型字符串：`文字` / `图片` / `视频` / `文件` / `语音` 等 |
| `url` | 媒体资源链接（已上传 OSS 时为 HTTP URL，未配置 OSS 时为 base64） |
| `mediaInfo` | 视频号/名片/h5链接等结构化元数据 |

### 处理规则（inbound.ts）

1. **跳过判断**：`!msg.content?.trim() && !msg.url` — 有 url 时不能跳过（图片消息 content 可能为空）
2. **base64 过滤**：`msg.url?.startsWith("data:")` 时不注入 `MediaUrl`，避免超长 token 爆炸
3. **MediaUrl 注入**：仅 HTTP URL 时写入 `MediaUrl`/`MediaUrls`/`MediaPath`/`MediaType`
4. **body 优先级**：`content`（已格式化的描述文字） > `<media:${type}>` placeholder

```ts
const mediaUrl = msg.url && !msg.url.startsWith("data:") ? msg.url : undefined;
const body = msg.content?.trim() || (isMediaMsg ? `<media:${msg.type}>` : "");

...(mediaUrl ? {
  MediaUrl: mediaUrl,
  MediaUrls: [mediaUrl],
  MediaPath: mediaUrl,
  MediaType: msg.type === "图片" ? "image/jpeg" : msg.type === "视频" ? "video/mp4" : undefined,
} : {}),
```

### 场景对照

| 场景 | `content` | `url` | AI 收到 |
|------|-----------|-------|---------|
| 纯文字 | 消息文本 | — | 消息文本 |
| 图片（有 OSS） | 包含链接的描述 | HTTP URL | 描述文字 + `MediaUrl` |
| 图片（无 OSS） | 含 base64 的描述 | `data:image/...` | 仅描述文字，base64 被过滤 |
| 空 content + URL | — | HTTP URL | `<media:图片>` placeholder |

---

## 10. 测试工具链

```
socket-server/   — npm run dev     自动加载 .env，预置测试账号
socket-client/   — npm start       交互式终端，输入消息→看 AI 回复
socket-chat/     — npx vitest run src/integration.test.ts
```

三个目录各自有 `.env`（被 `.gitignore` 忽略），`.env.example` 作为模板提交到 git。
