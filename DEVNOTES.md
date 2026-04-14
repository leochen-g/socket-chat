# socket-chat 开发笔记

## 调试经验

### 群消息有日志但没有回复

**现象**：openclaw 日志出现 `inbound msg ... in group ...`，但群里没有 AI 回复。

**排查顺序**：

1. **wechaty 侧是否转发了消息到 MQTT？**
   `on-claw-message.js` 中文字消息有关键词过滤（`forwardIncludeKeywordsMsg`）。
   若 `forwardAllMsg=false` 且消息不含关键词，消息不会发出去，openclaw 侧根本收不到。
   → 开启 `forwardAllMsg=true`，或确认关键词配置。

2. **插件版本是否是最新的？**
   openclaw 配置中 `plugins.installs['socket-chat'].version` 显示安装版本。
   修复代码后需要重新安装：`openclaw plugins install @openclaw-channel/socket-chat@x.x.x`

3. **`isGroupMention` 等字段是否被正确解析？**
   见下节"parseInboundMessage 必须覆盖所有字段"。

4. **群访问控制是否通过？**
   检查 `groupPolicy` 配置，`open`（默认）允许所有群；`allowlist` 需配置 `groups`。

---

## 已知坑

### parseInboundMessage 必须覆盖 SocketChatInboundMessage 的所有字段

`mqtt-client.ts` 中的 `parseInboundMessage` 负责把原始 MQTT JSON 解析为
`SocketChatInboundMessage`。**如果漏字段，该字段在 `inbound.ts` 中始终为 `undefined`**，
不会有任何报错，只会静默出错。

曾经漏掉的字段（已修复）：
- `isGroupMention` — 导致群 @提及检查永远失败，消息被静默丢弃
- `type` — 媒体消息类型判断失效，`<media:type>` placeholder 变成 `<media:undefined>`
- `url` — 媒体消息链接丢失，OSS 图片/视频无法传给 agent
- `mediaInfo` — 媒体元数据丢失

**每次在 `types.ts` 中给 `SocketChatInboundMessage` 加字段后，必须同步更新 `parseInboundMessage`。**

---

## 群访问控制设计

参考飞书（`extensions/feishu/src/bot.ts`）、IRC、nextcloud-talk 实现，两层校验：

### 第一层：群级（groupId）

控制"哪些群允许触发 AI"。

| `groupPolicy` | 行为 |
|--------------|------|
| `open`（默认）| 所有群允许 |
| `allowlist` | 仅 `groups` 列表中的群允许；首次拦截时向群发一条提醒（进程内只发一次） |
| `disabled` | 禁止所有群触发 AI，静默丢弃 |

```yaml
channels:
  socket-chat:
    groupPolicy: allowlist
    groups:
      - 'R:10804599808581977'
```

**一次性提醒机制**：模块级 `Set<string>`（键为 `accountId:groupId`），
首次拦截时发提醒并记录，后续静默。进程重启后重置。

### 第二层：sender 级（群内谁能触发）

控制"群内哪些成员可以触发 AI"。不配置或为空 = 允许所有群成员。

```yaml
channels:
  socket-chat:
    groupAllowFrom:
      - 'wxid_123456'    # 按 senderId 匹配
      - 'Alice'          # 按 senderName 匹配（大小写不敏感）
      - '*'              # 通配，允许所有
```

被拦截的 sender 静默丢弃，不发任何提醒（群聊 pairing 不适合，消息对所有人可见）。

### 第三层：@提及检查

`requireMention: true`（默认）时，群消息必须 `isGroupMention=true` 或内容含 `@{robotId}`。

**校验顺序**：群级 → sender 级 → @提及检查。DM 消息走 `dmPolicy`，与群校验完全独立。

---

## 测试注意事项

### notifiedGroups Set 的跨测试污染

`inbound.ts` 的 `notifiedGroups` 是模块级 Set，跨测试共享。
测试"只提醒一次"行为时，必须在 `beforeEach` 调用 `_resetNotifiedGroupsForTest()` 重置：

```ts
import { _resetNotifiedGroupsForTest } from "./inbound.js";

beforeEach(() => {
  _resetNotifiedGroupsForTest();
});
```

### SDK stub 需要与实际 import 保持同步

`src/__sdk-stub__.ts` 是测试用的 `openclaw/plugin-sdk` 替代。
每次在 `inbound.ts` 中从 `openclaw/plugin-sdk` 新增 import，必须同步在 stub 里导出，
否则测试会报 `Cannot find module` 或导出不存在错误。

---

## 媒体文件本地化（inbound）

### 设计决策

AI agent 直接读取本地文件路径比依赖外部 URL 更可靠：外部 URL 可能因权限、过期、网络问题而无法访问，而本地化后的文件路径在 agent 处理时始终可用。因此入站媒体消息在派发给 agent 之前，先将媒体内容下载/解码到本地，ctxPayload 中的 `MediaPath` 字段携带本地路径而非原始 URL。

### 实现路径

入站处理函数 `handleInboundMessage`（`src/inbound.ts`）在安全/提及检查通过后、路由之前执行媒体本地化。`msg.url` 有值时才进入此逻辑。

**路径 A：HTTP/HTTPS URL**

1. 调用 `channelRuntime.media.fetchRemoteMedia({ url, filePathHint, maxBytes })` 发起 HTTP 下载，拿到 `{ buffer, contentType }`
2. 调用 `detectMime({ buffer, headerMime: contentType, filePath: url })` 检测 MIME
3. 调用 `channelRuntime.media.saveMediaBuffer(buffer, mime, "inbound", maxBytes)` 落盘，拿到 `{ path, contentType }`

**路径 B：base64 data URL**

格式：`data:<mime>;base64,<payload>`

1. 解析 `data:` 前缀，提取 MIME（逗号前的 meta 去掉 `;base64` 部分）和 base64 载荷
2. 大小预检：`Math.ceil(base64Data.length * 0.75)` 估算原始字节数，超过 `maxBytes` 则抛出异常（进入降级逻辑）
3. `Buffer.from(base64Data, "base64")` 解码为 buffer
4. 同路径 A 的步骤 2–3：`detectMime` + `saveMediaBuffer`

**统一出口**

两条路径成功后都调用：
```ts
resolvedMediaPayload = buildMediaPayload([
  { path: saved.path, contentType: saved.contentType },
]);
```
生成的字段（`MediaPath`, `MediaUrl`, `MediaPaths`, `MediaUrls`, `MediaType`）通过 `...resolvedMediaPayload` 展开写入 `ctxPayload`。

### 关键 API

| API | 来源 | 作用 |
|-----|------|------|
| `channelRuntime.media.fetchRemoteMedia` | Plugin SDK runtime | HTTP 下载远端媒体，返回 buffer + contentType，内部遵守 maxBytes 限制 |
| `channelRuntime.media.saveMediaBuffer` | Plugin SDK runtime | 将 buffer 持久化到框架管理的本地媒体目录，返回 `{ path, contentType }` |
| `buildMediaPayload` | `openclaw/plugin-sdk` | 将 `{ path, contentType }[]` 转为 ctxPayload 媒体标准字段 |
| `resolveChannelMediaMaxBytes` | `openclaw/plugin-sdk` | 从全局 cfg 读取媒体大小上限（MB 转字节），找不到则返回框架默认值 |
| `detectMime` | `openclaw/plugin-sdk` | 综合 buffer magic bytes + HTTP Content-Type header + 文件扩展名推断 MIME |

### 注意事项

**base64 大小预检逻辑**

base64 编码后字符数 × 0.75 ≈ 原始字节数（忽略 padding 误差），用 `Math.ceil` 向上取整做保守估算。预检在 `Buffer.from` 之前执行，避免先分配大内存再拒绝。

**失败降级策略**

整个媒体本地化块（含下载、解码、保存）包裹在 `try/catch` 中。任何步骤失败只执行 `log.warn`，`resolvedMediaPayload` 保持为空对象 `{}`，消息处理继续进行，文字内容正常派发给 agent。这样单张图片下载失败不会阻塞整个对话。

**maxBytes 配置方式**

`resolveChannelMediaMaxBytes` 通过 `resolveChannelLimitMb` 回调读取：

```ts
const maxBytes = resolveChannelMediaMaxBytes({
  cfg: ctx.cfg,
  resolveChannelLimitMb: ({ cfg }) =>
    (cfg as CoreConfig).channels?.["socket-chat"]?.mediaMaxMb,
  accountId,
});
```

目前 socket-chat 的 `CoreConfig` schema 中未定义 `mediaMaxMb` 字段，所以该回调返回 `undefined`，由框架使用内置默认值（通常为数十 MB）。如需自定义限制，在 `CoreConfig` schema 中添加 `mediaMaxMb?: number` 并在配置文件中设置即可。

**SDK stub 更新**

新增了三个从 `openclaw/plugin-sdk` 导入的符号：`buildMediaPayload`、`resolveChannelMediaMaxBytes`、`detectMime`。如果运行测试报导出不存在错误，需要在 `src/__sdk-stub__.ts` 中补充这三个符号的 mock 导出。

---

## Gateway 启动日志说明

### "abort signal, disconnecting" / "monitor stopped" 出现在启动日志中

**现象**：网关启动后日志出现：
```
gateway/channels/socket-chat [default] abort signal, disconnecting
[default] monitor stopped
```
随后又出现正常的连接日志。

**原因**：这是旧进程优雅关闭的日志，不是新进程的报错。
- 旧进程和新进程写入同一个日志文件，日志会交错出现
- 旧进程收到 SIGTERM → 触发 AbortSignal → MQTT 断开连接 → 输出上述日志
- 新进程随后启动，输出 `"[default] starting socket-chat MQTT provider"` 后正常连接

**判断方法**：新进程日志中有 `"starting socket-chat MQTT provider"` 再无上述错误，即为正常。确认：`openclaw channels status` 显示 `running, connected`。

---

### "launchctl stop did not fully stop the service; used bootout fallback and left service unloaded"

**现象**：执行 `openclaw gateway stop` 或 `openclaw gateway restart` 时打印此警告。

**原因**：`stopLaunchAgent`（`src/daemon/launchd.ts`）的降级逻辑：
1. 先 `launchctl disable` 抑制 KeepAlive
2. 发 `launchctl stop`，然后每 100ms 轮询一次，最多等 1 秒
3. 1 秒内进程未退出 → 调用 `launchctl bootout` 强制卸载，并打印该警告

socket-chat 的 MQTT monitor 在收到 abort 后会向 broker 发 DISCONNECT 包，等待 ACK，这个往返通常超过 1 秒，触发降级路径。这是**正常的优雅关闭**，不是 bug。

**影响**：`bootout` 会将 LaunchAgent 从 launchd 注册表中移除，但：
- `openclaw gateway restart` 后续会检测到 "not-loaded" 状态并重新 `bootstrap` + `kickstart`，整个 restart 仍然成功
- `openclaw gateway stop` 场景下再次 start 也会重新 bootstrap

**结论**：该警告可以忽略，网关最终状态是正确的。

---

## SDK 重构说明（channel-api.ts / runtime-api.ts）

### 根目录新增文件

经过 SDK 热路径重构，插件入口从单个 `index.ts` 拆分为三层：

| 文件 | 用途 | 加载时机 |
|------|------|---------|
| `index.ts` | 插件注册入口，re-export 插件对象 | 框架启动时静态加载 |
| `channel-api.ts` | channel 启动所需的最小集合（gateway、outbound 等） | 热路径，框架按需加载 |
| `runtime-api.ts` | 重型运行时路径（send、monitor、probe、onboard 等） | 仅在实际用到时动态加载 |

**tsconfig.json 的 include 必须包含三个文件**：
```json
"include": ["index.ts", "channel-api.ts", "runtime-api.ts", "src/**/*.ts"]
```
漏掉会导致 `tsc` 不输出对应的 `.js`，运行时 `import` 失败。

### channel 状态更新

`channel.ts` 的 `startAccount` 使用 `createAccountStatusSink` 替代直接调用 `ctx.setStatus`：

```ts
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";

const statusSink = createAccountStatusSink({
  accountId: ctx.accountId,
  setStatus: ctx.setStatus,
});
```

`statusSink` 是 `(patch: Omit<ChannelAccountSnapshot, "accountId">) => void`，内部自动拼入 `accountId`。状态 patch 直接传给 `monitorSocketChatProviderWithRegistry`，由 monitor 在连接/断开/重连时调用。

### 为什么不用 runStoppablePassiveMonitor

IRC extension 用 `runStoppablePassiveMonitor`，因为 `monitorIrcProvider` 返回一个 `StoppableMonitor` 句柄（非阻塞启动）。

socket-chat 的 `monitorSocketChatProviderWithRegistry` 是 `async Promise<void>`，它自己内部循环并监听 `abortSignal`，整个函数在连接断开前不返回。**不能用 `runStoppablePassiveMonitor`**（类型不兼容，也没必要），直接 `return monitorSocketChatProviderWithRegistry(...)` 即可。

---

## 发布流程

1. 修改代码
2. 更新 `package.json` 版本号
3. `npx vitest run` 确认全部通过
4. `git commit && git push`
5. （如需发布 npm）`npm publish --access public`
6. 在 openclaw 服务端：`openclaw plugins install @openclaw-channel/socket-chat@x.x.x`
7. 重启 openclaw 使新版本生效
