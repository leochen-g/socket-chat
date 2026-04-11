# socket-chat: Full Refactor to New Plugin SDK Patterns

**Date:** 2026-04-12
**Status:** Approved
**Scope:** `/Users/leo/project/openclaw-project/socket-chat/`

---

## Problem Statement

The openclaw core upgraded its Plugin SDK barrel (`"openclaw/plugin-sdk"`), removing several functions that `socket-chat` imports directly:

- `resolveAllowlistMatchByCandidates` → moved to `openclaw/plugin-sdk/allow-from`
- `createNormalizedOutboundDeliverer` → replaced by `deliverFormattedTextWithAttachments` in `openclaw/plugin-sdk/reply-payload`
- `buildMediaPayload` → moved to `openclaw/plugin-sdk/reply-payload`
- `resolveChannelMediaMaxBytes` → moved to `openclaw/plugin-sdk/reply-payload`
- `detectMime` → moved to `openclaw/plugin-sdk/mime`
- `buildBaseChannelStatusSummary` / `buildBaseAccountStatusSnapshot` / `collectStatusIssuesFromLastError` → removed from barrel
- `ChannelOutboundAdapter` → moved to `openclaw/plugin-sdk/core`

Tests currently pass because `vitest.config.ts` aliases `"openclaw/plugin-sdk"` → `__sdk-stub__.ts`, which bypasses the barrel by importing from openclaw source files. In production there is no such redirect — and there is no `index.ts` entry point declared in `package.json`.

---

## Solution: Full Refactor to IRC/nextcloud-talk Patterns

Align socket-chat with the current bundled channel architecture as seen in `openclaw/extensions/irc` and `openclaw/extensions/nextcloud-talk`.

---

## Architecture

### Runtime Initialization

The existing `index.ts` (which uses an old `OpenClawPluginApi`/`register(api)` pattern) is **completely replaced** with a `defineBundledChannelEntry` call. This tells the openclaw host to inject a full `PluginRuntime` at startup:

```ts
// index.ts (new — replaces existing file entirely)
export default defineBundledChannelEntry({
  id: "socket-chat",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-api.js", exportName: "socketChatPlugin" },
  runtime: { specifier: "./runtime-api.js", exportName: "setSocketChatRuntime" },
});
```

The specifiers `"./channel-api.js"` and `"./runtime-api.js"` must match the root-level barrel filenames exactly (`channel-api.ts` and `runtime-api.ts`). The runtime is stored in a typed mutable slot (`createPluginRuntimeStore`) and accessed via `getSocketChatRuntime()` inside the plugin.

```
openclaw host
  → reads index.ts (defineBundledChannelEntry)
  → calls setSocketChatRuntime(runtime)   ← via runtime-api.ts
  → loads socketChatPlugin                ← via channel-api.ts
```

### Inbound Flow

The existing bespoke access-control functions in `inbound.ts` — `enforceDmAccess`, `checkGroupAccess`, `checkGroupSenderAccess`, `checkGroupMention` — are **deleted entirely**. Their behavior is replaced by `createChannelPairingController` built-ins (DM allowlist, group mention policy) plus the `security` config block in `createChatChannelPlugin`.

```
MQTT broker
  → mqtt-client.ts: subscribe, parse topic/payload
  → handleSocketChatInbound({ msg, accountId, config, runtime, statusSink, sendReply })
      → getSocketChatRuntime()
      → createChannelPairingController({ core, channel, accountId })
      → build ctxPayload (From/To with channel prefix, SessionKey, etc.)
      → dispatchInboundReplyWithBase({
            core, channel, accountId,
            ctxPayload,
            deliver: deliverFormattedTextWithAttachments({
              sendText: async (payload) => {
                const client = getActiveMqttClient(accountId)
                await client.publish(replyTarget, payload.text)
              }
            })
         })
```

Key invariants:
- DM/group distinction: private chat uses `peer: { kind: "direct" }`, group uses `peer: { kind: "group" }`
- Group `@` mentions: target format `group:17581395450@chatroom|wxid_a,wxid_b` (unchanged — `|` separates groupId from mentionIds to avoid conflict with native `@chatroom` suffix)
- `blockStreaming: true` encoded as `deliveryMode: "block"` in outbound base adapter
- Media handling stays in outbound

### Outbound Flow

`outbound.ts` currently contains both the outbound adapter and helper functions shared with other modules:

- `parseSocketChatTarget` — **stays** in `outbound.ts`; used by both `mqtt-client.ts` and the adapter
- `buildTextPayload` — **deleted**; text formatting is handled by `deliverFormattedTextWithAttachments`
- `buildMediaPayload` (local, socket-chat-specific) — **renamed** to `buildSocketChatMediaPayload` to avoid collision with the SDK's `buildMediaPayload` imported from `openclaw/plugin-sdk/reply-payload`
- `sendSocketChatMessage` — **stays** as the shared MQTT publish helper

The adapter shape changes from `ChannelOutboundAdapter` to `{ base, attachedResults }`:

```
base: {
  deliveryMode: "block",
  chunker: (text, limit) => runtime.channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: config.textChunkLimit,
}

attachedResults: {
  channel: "socket-chat",
  sendText: async ({ accountId, replyTarget, text }) => { ... publish via MQTT ... },
  sendMedia: async ({ accountId, replyTarget, payload }) => {
    // HTTP URL → fetchRemoteMedia; base64 → Buffer.from
    // buildSocketChatMediaPayload → sendSocketChatMessage
  },
}
```

---

## File Changes

### New Files

| File | Purpose |
|------|---------|
| `index.ts` | **Replaces** existing `index.ts`. Bundled channel entry using `defineBundledChannelEntry`. Specifiers point to `"./channel-api.js"` and `"./runtime-api.js"` |
| `runtime-api.ts` | Root-level barrel re-exporting `setSocketChatRuntime` from `src/runtime.ts` |
| `channel-api.ts` | Root-level barrel re-exporting `socketChatPlugin` from `src/channel.ts` |
| `src/runtime-api.ts` | Internal barrel inside `src/` — re-exports all needed SDK subpaths for use within the plugin |

### Updated Files

| File | Change Summary |
|------|---------------|
| `src/runtime.ts` | Replace manual `let runtime = null` with `createPluginRuntimeStore<PluginRuntime>(...)` |
| `src/inbound.ts` | Full rewrite: delete bespoke access-control functions; use `getSocketChatRuntime` + `createChannelPairingController` + `dispatchInboundReplyWithBase` |
| `src/channel.ts` | Replace manual `ChannelPlugin` object with `createChatChannelPlugin` factory |
| `src/outbound.ts` | Delete `buildTextPayload`; rename local `buildMediaPayload` → `buildSocketChatMediaPayload`; switch adapter shape to `{ base, attachedResults }` |
| `src/mqtt-client.ts` | Replace `ctx: ChannelGatewayContext` param with `{ config, runtime, statusSink }` pattern; add `createAccountStatusSink` |
| `src/__sdk-stub__.ts` | Update to re-export from new SDK subpath source files; add `createPluginRuntimeStore` |
| `vitest.config.ts` | Add per-subpath aliases for each `openclaw/plugin-sdk/<subpath>` used in production code |

---

## Internal Barrel (`src/runtime-api.ts`)

Mirrors `openclaw/extensions/irc/src/runtime-api.ts`:

```ts
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export { deliverFormattedTextWithAttachments } from "openclaw/plugin-sdk/reply-payload";
export { resolveAllowlistMatchByCandidates } from "openclaw/plugin-sdk/allow-from";
export { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
export { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export { buildMediaPayload, resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/reply-payload";
export { detectMime } from "openclaw/plugin-sdk/mime";
export { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
```

---

## Test Strategy

### `__sdk-stub__.ts` Updates

Rewrite exports to match the new SDK subpath functions. Note: `createPluginRuntimeStore` is needed because tests that import `src/runtime.ts` transitively pull in `openclaw/plugin-sdk/runtime-store`.

```ts
export { deliverFormattedTextWithAttachments } from "../../openclaw/src/plugin-sdk/reply-payload.js";
export { dispatchInboundReplyWithBase } from "../../openclaw/src/plugin-sdk/inbound-reply-dispatch.js";
export { createChannelPairingController } from "../../openclaw/src/plugin-sdk/channel-pairing.js";
export { resolveAllowlistMatchByCandidates } from "../../openclaw/src/channels/allowlist-match.js";
export { buildMediaPayload, resolveChannelMediaMaxBytes } from "../../openclaw/src/channels/plugins/media-payload.js";
export { detectMime } from "../../openclaw/src/media/mime.js";
export { createAccountStatusSink } from "../../openclaw/src/plugin-sdk/channel-lifecycle.js";
export { createChatChannelPlugin } from "../../openclaw/src/plugin-sdk/channel-core.js";
export { createPluginRuntimeStore } from "../../openclaw/src/plugin-sdk/runtime-store.js";
export type { PluginRuntime } from "../../openclaw/src/plugin-sdk/index.js";
```

### `vitest.config.ts` Alias Updates

Each SDK subpath gets its own alias pointing to the corresponding openclaw source file. Subpath aliases must be listed **before** the broad `"openclaw/plugin-sdk"` fallback so vite resolves them first:

```ts
alias: [
  { find: "openclaw/plugin-sdk/reply-payload",          replacement: "<openclaw>/src/plugin-sdk/reply-payload.ts" },
  { find: "openclaw/plugin-sdk/allow-from",             replacement: "<openclaw>/src/channels/allowlist-match.ts" },
  { find: "openclaw/plugin-sdk/channel-pairing",        replacement: "<openclaw>/src/plugin-sdk/channel-pairing.ts" },
  { find: "openclaw/plugin-sdk/inbound-reply-dispatch", replacement: "<openclaw>/src/plugin-sdk/inbound-reply-dispatch.ts" },
  { find: "openclaw/plugin-sdk/channel-lifecycle",      replacement: "<openclaw>/src/plugin-sdk/channel-lifecycle.ts" },
  { find: "openclaw/plugin-sdk/channel-core",           replacement: "<openclaw>/src/plugin-sdk/channel-core.ts" },
  { find: "openclaw/plugin-sdk/mime",                   replacement: "<openclaw>/src/media/mime.ts" },
  { find: "openclaw/plugin-sdk/runtime-store",          replacement: "<openclaw>/src/plugin-sdk/runtime-store.ts" },
  { find: "openclaw/plugin-sdk/runtime",                replacement: "<openclaw>/src/plugin-sdk/runtime.ts" },
  { find: "openclaw/plugin-sdk",                        replacement: "<socket-chat>/src/__sdk-stub__.ts" },
]
```

(`<openclaw>` = `path.join(dir, "..", "openclaw")`, `<socket-chat>` = `dir`)

### Test File Updates

- `inbound.test.ts`: Replace `ctx.channelRuntime` mock pattern with `setSocketChatRuntime({ channel: { pairing, commands, ... } } as unknown as PluginRuntime)` before each test
- New `inbound.authz.test.ts`: Cover DM allow/block via allowlist, group mention requirement, pairing request creation (mirrors `nextcloud-talk/src/inbound.authz.test.ts`)

---

## Implementation Order

1. `src/runtime.ts` — establish runtime store (no deps)
2. `src/runtime-api.ts` — internal barrel (no deps)
3. `src/outbound.ts` — new adapter shape; rename local `buildMediaPayload` → `buildSocketChatMediaPayload`
4. `src/channel.ts` — new plugin factory using `createChatChannelPlugin`
5. `channel-api.ts` — root-level barrel re-exporting `socketChatPlugin`
6. `index.ts` + `runtime-api.ts` — root-level entry points (replace existing `index.ts`)
7. `src/inbound.ts` — full rewrite with new dispatch, delete old access-control functions
8. `src/mqtt-client.ts` — new calling convention with `createAccountStatusSink`
9. `src/__sdk-stub__.ts` + `vitest.config.ts` — test infrastructure
10. `inbound.test.ts` + `inbound.authz.test.ts` — tests

---

## Verification Gates

- `cd socket-chat && npx vitest run` — all tests pass
- `pnpm build` in openclaw repo — no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings
- No deep `src/**` imports from production code (only `openclaw/plugin-sdk/*` and local barrels)
