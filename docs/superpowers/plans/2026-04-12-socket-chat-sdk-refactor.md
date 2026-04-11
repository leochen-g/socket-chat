# socket-chat SDK Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor socket-chat to use new openclaw Plugin SDK subpath imports, fixing the broken production entry point while aligning with IRC/nextcloud-talk patterns.

**Architecture:** Replace the old `"openclaw/plugin-sdk"` barrel imports (removed in the SDK upgrade) with narrower subpath imports (`"openclaw/plugin-sdk/reply-payload"`, etc.). Rewrite `inbound.ts` to use `dispatchInboundReplyWithBase` + `createChannelPairingController`. Create proper `index.ts` using `defineBundledChannelEntry`. Update test infrastructure to alias each new subpath.

**Tech Stack:** TypeScript ESM, MQTT.js v5, Zod v4, openclaw Plugin SDK subpaths, Vitest

**Reference files:** `openclaw/extensions/irc/src/runtime.ts`, `inbound.ts`, `runtime-api.ts`, `gateway.ts`, `outbound-base.ts`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/runtime.ts` | Modify | Runtime store using `createPluginRuntimeStore` |
| `src/runtime-api.ts` | **Create** | Internal barrel re-exporting SDK subpaths |
| `src/__sdk-stub__.ts` | Modify | Test stub — new SDK subpath exports |
| `vitest.config.ts` | Modify | Per-subpath aliases for test infrastructure |
| `src/outbound.ts` | Modify | Rename local `buildMediaPayload`; define base adapter |
| `src/inbound.ts` | Modify | Rewrite with `dispatchInboundReplyWithBase` pattern |
| `src/mqtt-client.ts` | Modify | New calling convention for `handleSocketChatInbound` |
| `src/channel.ts` | Modify | Fix broken status-helper imports; new outbound shape |
| `channel-api.ts` | **Create** | Root barrel re-exporting `socketChatPlugin` |
| `runtime-api.ts` | **Create** | Root barrel re-exporting `setSocketChatRuntime` |
| `index.ts` | Replace | `defineBundledChannelEntry` (replaces old plugin API) |
| `src/inbound.test.ts` | Modify | Use `setSocketChatRuntime` mock pattern |
| `src/inbound.authz.test.ts` | **Create** | DM + group authorization tests |

---

## Task 1: Update `src/runtime.ts` — use `createPluginRuntimeStore`

**Files:**
- Modify: `src/runtime.ts`

- [ ] **Step 1: Replace manual runtime slot with `createPluginRuntimeStore`**

Replace the entire file content:

```ts
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setSocketChatRuntime,
  getRuntime: getSocketChatRuntime,
  clearRuntime: clearSocketChatRuntime,
} = createPluginRuntimeStore<PluginRuntime>("socket-chat runtime not initialized");

export { setSocketChatRuntime, getSocketChatRuntime, clearSocketChatRuntime };
```

Note: `clearSocketChatRuntime` is used in tests to reset state between test cases.

- [ ] **Step 2: Verify file compiles (no TS errors expected yet — subpath not aliased)**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
# Skip TS check for now — vitest alias not set up yet. Move to next task.
```

---

## Task 2: Create `src/runtime-api.ts` — internal SDK subpath barrel

**Files:**
- Create: `src/runtime-api.ts`

This barrel mirrors `openclaw/extensions/irc/src/runtime-api.ts`. All production imports of SDK subpaths in `inbound.ts`, `channel.ts`, and `mqtt-client.ts` go through this file — never directly to `"openclaw/plugin-sdk/*"` in those files.

- [ ] **Step 1: Create `src/runtime-api.ts`**

```ts
// Internal runtime barrel for socket-chat extension.
// All SDK subpath imports are centralised here.

export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { ChannelAccountSnapshot, ChannelStatusIssue } from "openclaw/plugin-sdk/status-helpers";

export { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
export { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export {
  deliverFormattedTextWithAttachments,
  buildMediaPayload,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/reply-payload";
export { resolveAllowlistMatchByCandidates } from "openclaw/plugin-sdk/allow-from";
export { detectMime } from "openclaw/plugin-sdk/mime";
export {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk/status-helpers";
```

Note: `buildMediaPayload` here is the **SDK's** media payload builder (for inbound media localization). The local `outbound.ts` has its own payload builders which will be renamed to avoid collision.

---

## Task 3: Update test infrastructure — `__sdk-stub__.ts` and `vitest.config.ts`

**Files:**
- Modify: `src/__sdk-stub__.ts`
- Modify: `vitest.config.ts`

Do this before implementing the new inbound so tests can run incrementally.

- [ ] **Step 1: Replace `src/__sdk-stub__.ts` entirely**

```ts
/**
 * Minimal openclaw/plugin-sdk stub for socket-chat unit tests.
 *
 * Imports from openclaw source files directly (not through the barrel) to
 * avoid pulling in modules like json5 that require the openclaw workspace.
 * Each entry must match what src/runtime-api.ts exports via SDK subpaths.
 */
const oc = "../../openclaw/src";

export { createPluginRuntimeStore } from `${oc}/plugin-sdk/runtime-store.js`;
export { createChannelPairingController } from `${oc}/plugin-sdk/channel-pairing.js`;
export { createAccountStatusSink } from `${oc}/plugin-sdk/channel-lifecycle.js`;
export { dispatchInboundReplyWithBase } from `${oc}/plugin-sdk/inbound-reply-dispatch.js`;
export {
  deliverFormattedTextWithAttachments,
  buildMediaPayload,
  resolveChannelMediaMaxBytes,
} from `${oc}/plugin-sdk/reply-payload.js`;
export { resolveAllowlistMatchByCandidates } from `${oc}/plugin-sdk/allow-from.js`;
export { detectMime } from `${oc}/media/mime.js`;
export {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from `${oc}/plugin-sdk/status-helpers.js`;

// type-only re-exports (erased at runtime)
export type { PluginRuntime } from `${oc}/plugin-sdk/runtime-store.js`;
export type { OutboundReplyPayload } from `${oc}/plugin-sdk/reply-payload.js`;
export type { ChannelPlugin } from `${oc}/plugin-sdk/channel-core.js`;
export type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from `${oc}/plugin-sdk/status-helpers.js`;
```

**Important:** The template literals above are illustrative shorthand. Write them as actual paths using `"../../openclaw/src/..."` strings. Example:
```ts
export { createPluginRuntimeStore } from "../../openclaw/src/plugin-sdk/runtime-store.js";
```

- [ ] **Step 2: Update `vitest.config.ts` to add per-subpath aliases**

Replace the existing config:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));
const openclawSrc = path.join(dir, "..", "openclaw", "src");
const sdkSrc = path.join(openclawSrc, "plugin-sdk");
const stub = path.join(dir, "src", "__sdk-stub__.ts");

export default defineConfig({
  resolve: {
    alias: [
      // Subpath aliases MUST be listed before the broad fallback below.
      // Vite resolves aliases in order: first match wins.
      { find: "openclaw/plugin-sdk/runtime-store",          replacement: path.join(sdkSrc, "runtime-store.ts") },
      { find: "openclaw/plugin-sdk/channel-pairing",        replacement: path.join(sdkSrc, "channel-pairing.ts") },
      { find: "openclaw/plugin-sdk/channel-lifecycle",      replacement: path.join(sdkSrc, "channel-lifecycle.ts") },
      { find: "openclaw/plugin-sdk/inbound-reply-dispatch", replacement: path.join(sdkSrc, "inbound-reply-dispatch.ts") },
      { find: "openclaw/plugin-sdk/reply-payload",          replacement: path.join(sdkSrc, "reply-payload.ts") },
      { find: "openclaw/plugin-sdk/allow-from",             replacement: path.join(sdkSrc, "allow-from.ts") },
      { find: "openclaw/plugin-sdk/mime",                   replacement: path.join(openclawSrc, "media", "mime.ts") },
      { find: "openclaw/plugin-sdk/status-helpers",         replacement: path.join(sdkSrc, "status-helpers.ts") },
      { find: "openclaw/plugin-sdk/channel-core",           replacement: path.join(sdkSrc, "channel-core.ts") },
      { find: "openclaw/plugin-sdk/runtime",                replacement: path.join(sdkSrc, "runtime.ts") },
      { find: "openclaw/plugin-sdk/channel-status",         replacement: path.join(sdkSrc, "channel-status.ts") },
      // Broad fallback: catches any remaining "openclaw/plugin-sdk" imports
      // (e.g. type-only imports from inbound.ts, channel.ts).
      { find: "openclaw/plugin-sdk",                        replacement: stub },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
```

- [ ] **Step 3: Run tests (expect existing tests to fail — that's correct)**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run 2>&1 | head -50
```

Expected: errors about missing exports from `inbound.ts` / `channel.ts` (those modules still have old imports). Tests that exercise `src/config.ts` or `src/outbound.ts` alone may still pass.

---

## Task 4: Update `src/outbound.ts` — rename local `buildMediaPayload`; add base adapter export

**Files:**
- Modify: `src/outbound.ts`

- [ ] **Step 1: Rename `buildMediaPayload` → `buildSocketChatMediaPayload`**

In `src/outbound.ts`, rename the local function and update the one internal call site:

```ts
// Before:
export function buildMediaPayload(to: string, imageUrl: string, caption?: string): ...

// After:
export function buildSocketChatMediaPayload(to: string, imageUrl: string, caption?: string): ...
```

Also update the `sendMedia` method inside `socketChatOutbound` that calls `buildMediaPayload(...)` → `buildSocketChatMediaPayload(...)`.

- [ ] **Step 2: Remove `ChannelOutboundAdapter` type import from main barrel**

Remove:
```ts
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
```

The adapter shape is no longer typed as `ChannelOutboundAdapter`. The `socketChatOutbound` export remains an object literal — the type is inferred.

- [ ] **Step 3: Delete `buildTextPayload` export**

Remove the `buildTextPayload` function entirely. The `sendSocketChatMessage` helper and `parseSocketChatTarget` stay unchanged.

Update `src/channel.ts`'s import of `buildTextPayload` (used in `notifyApproval`): replace the call with an inline `buildSocketChatMediaPayload`-equivalent, OR call `buildSocketChatMediaPayload` — but since `notifyApproval` only sends text, use `parseSocketChatTarget` + construct the payload directly:

```ts
// In channel.ts notifyApproval, replace buildTextPayload usage:
const parsedTarget = parseSocketChatTarget(id);
const payload: SocketChatOutboundPayload = {
  ...parsedTarget,
  messages: [{ type: 1, content: "You have been approved to chat with this assistant." }],
};
await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
```

- [ ] **Step 4: Run relevant tests**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|Error)"
```

---

## Task 5: Rewrite `src/inbound.ts` — new dispatch pattern

**Files:**
- Modify: `src/inbound.ts`

This is the largest change. The file is rewritten top-to-bottom:
- **Delete:** `enforceDmAccess`, `checkGroupAccess`, `checkGroupSenderAccess`, `checkGroupMention`, `_resetNotifiedGroupsForTest`, `notifiedGroups`, `normalizeSocketChatId`
- **Keep:** `LogSink` type (can be simplified)
- **Rename:** `handleInboundMessage` → `handleSocketChatInbound` (new signature)
- **Add:** media localization using `core.channel.media` instead of `channelRuntime.media`

- [ ] **Step 1: Write the new `src/inbound.ts`**

```ts
import {
  createChannelPairingController,
  dispatchInboundReplyWithBase,
  deliverFormattedTextWithAttachments,
  resolveAllowlistMatchByCandidates,
  buildMediaPayload,
  resolveChannelMediaMaxBytes,
  detectMime,
  type OutboundReplyPayload,
} from "./runtime-api.js";
import { getSocketChatRuntime } from "./runtime.js";
import { resolveSocketChatAccount, type CoreConfig } from "./config.js";
import type { SocketChatInboundMessage } from "./types.js";

const CHANNEL_ID = "socket-chat" as const;

// ---------------------------------------------------------------------------
// DM access control helpers (simplified — no ctx dependency)
// ---------------------------------------------------------------------------

function normalizeSocketChatId(raw: string): string {
  return raw.replace(/^(socket-chat|sc):/i, "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Group access control (tier 1: group, tier 2: sender)
// Kept as pure functions — no external dependencies.
// ---------------------------------------------------------------------------

const notifiedGroups = new Set<string>();

/** Reset one-time group notification state (tests only). */
export function _resetNotifiedGroupsForTest(): void {
  notifiedGroups.clear();
}

function checkGroupAccess(params: {
  groupId: string;
  groupPolicy: string;
  groups: string[];
  log: LogSink;
  accountId: string;
}): { allowed: boolean } {
  const { groupId, groupPolicy, groups, log, accountId } = params;

  if (groupPolicy === "disabled") {
    log.info(`[${accountId}] group msg blocked (groupPolicy=disabled)`);
    return { allowed: false };
  }
  if (groupPolicy === "open") return { allowed: true };

  // allowlist
  if (groups.length === 0) return { allowed: false };
  const normalizedGroupId = normalizeSocketChatId(groupId);
  const normalizedGroups = groups.map(normalizeSocketChatId);
  if (normalizedGroups.includes("*") || normalizedGroups.includes(normalizedGroupId)) {
    return { allowed: true };
  }
  log.info(`[${accountId}] group ${groupId} not in groups allowlist`);
  return { allowed: false };
}

function checkGroupSenderAccess(params: {
  senderId: string;
  senderName: string | undefined;
  groupAllowFrom: string[];
  log: LogSink;
  accountId: string;
}): boolean {
  const { senderId, senderName, groupAllowFrom, log, accountId } = params;
  if (groupAllowFrom.length === 0) return true;
  const normalized = groupAllowFrom.map(normalizeSocketChatId);
  if (normalized.includes("*")) return true;
  const id = normalizeSocketChatId(senderId);
  const name = senderName ? senderName.trim().toLowerCase() : undefined;
  const allowed = normalized.includes(id) || (name !== undefined && normalized.includes(name));
  if (!allowed) log.info(`[${accountId}] group sender ${senderId} not in groupAllowFrom`);
  return allowed;
}

// ---------------------------------------------------------------------------
// Main inbound handler
// ---------------------------------------------------------------------------

type LogSink = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
};

/**
 * Handle a socket-chat MQTT inbound message.
 *
 * New pattern: gets PluginRuntime via getSocketChatRuntime(), uses
 * createChannelPairingController for DM access, dispatchInboundReplyWithBase
 * for reply dispatch.
 */
export async function handleSocketChatInbound(params: {
  msg: SocketChatInboundMessage;
  accountId: string;
  config: CoreConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  log: LogSink;
  sendReply: (to: string, text: string) => Promise<void>;
}): Promise<void> {
  const { msg, accountId, config, statusSink, log, sendReply } = params;

  // Skip empty messages (media-only messages with no URL also skipped)
  if (!msg.content?.trim() && !msg.url) {
    log.debug?.(`[${accountId}] skip empty message ${msg.messageId}`);
    return;
  }

  statusSink?.({ lastInboundAt: msg.timestamp });

  const core = getSocketChatRuntime();
  const account = resolveSocketChatAccount(config, accountId);
  const replyTarget = msg.isGroup ? `group:${msg.groupId}` : msg.senderId;

  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId,
  });

  // ---- DM access control ----
  if (!msg.isGroup) {
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") return;
    if (dmPolicy !== "open") {
      const configAllowFrom = (account.config.allowFrom ?? []).map(normalizeSocketChatId);
      const storeAllowFrom = (await pairing.readStoreForDmPolicy(dmPolicy)).map(normalizeSocketChatId);
      const mergedAllow = [...configAllowFrom, ...storeAllowFrom];

      const senderId = normalizeSocketChatId(msg.senderId);
      const senderName = msg.senderName ? msg.senderName.trim().toLowerCase() : undefined;
      const match = resolveAllowlistMatchByCandidates({
        allowList: mergedAllow,
        candidates: [
          { value: senderId, source: "id" as const },
          ...(senderName ? [{ value: senderName, source: "name" as const }] : []),
        ],
      });

      if (!mergedAllow.includes("*") && !match.allowed) {
        if (dmPolicy === "pairing") {
          await pairing.issueChallenge({
            senderId: msg.senderId.toLowerCase(),
            senderIdLine: `Your Socket Chat user id: ${msg.senderId}`,
            meta: { name: msg.senderName || undefined },
            sendPairingReply: async (text) => {
              await sendReply(replyTarget, text);
            },
            onReplyError: (err) => {
              log.warn(`[${accountId}] pairing reply failed for ${msg.senderId}: ${String(err)}`);
            },
          });
        } else {
          log.warn(`[${accountId}] blocked sender ${msg.senderId} (dmPolicy=${dmPolicy})`);
        }
        return;
      }
    }
  }

  // ---- Group access control ----
  if (msg.isGroup) {
    const groupId = msg.groupId ?? msg.senderId;
    const groupAccess = checkGroupAccess({
      groupId,
      groupPolicy: account.config.groupPolicy ?? "open",
      groups: account.config.groups ?? [],
      log,
      accountId,
    });
    if (!groupAccess.allowed) return;

    const senderAllowed = checkGroupSenderAccess({
      senderId: msg.senderId,
      senderName: msg.senderName,
      groupAllowFrom: account.config.groupAllowFrom ?? [],
      log,
      accountId,
    });
    if (!senderAllowed) return;
  }

  // ---- Group @mention check ----
  if (msg.isGroup) {
    const requireMention = account.config.requireMention !== false;
    if (requireMention) {
      const mentioned = msg.isGroupMention === true || msg.content.includes(`@${msg.robotId}`);
      if (!mentioned) {
        log.debug?.(`[${accountId}] group msg ${msg.messageId} skipped (requireMention, not mentioned)`);
        return;
      }
    }
  }

  const chatType = msg.isGroup ? "group" : "direct";
  const peerId = msg.isGroup ? (msg.groupId ?? msg.senderId) : msg.senderId;
  const isMediaMsg = !!msg.type && msg.type !== "文字";
  const body = msg.content?.trim() || (isMediaMsg ? `<media:${msg.type}>` : "");

  // ---- Media localization ----
  let resolvedMediaPayload: Record<string, unknown> = {};
  const mediaUrl = msg.url?.trim();
  if (mediaUrl) {
    try {
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg: config,
        resolveChannelLimitMb: ({ cfg }) =>
          (cfg as CoreConfig).channels?.["socket-chat"]?.mediaMaxMb,
        accountId,
      });

      let buffer: Buffer;
      let contentTypeHint: string | undefined;

      if (mediaUrl.startsWith("data:")) {
        const commaIdx = mediaUrl.indexOf(",");
        const meta = commaIdx > 0 ? mediaUrl.slice(5, commaIdx) : "";
        const base64Data = commaIdx > 0 ? mediaUrl.slice(commaIdx + 1) : "";
        contentTypeHint = meta.split(";")[0] || undefined;
        const estimatedBytes = Math.ceil(base64Data.length * 0.75);
        if (maxBytes && estimatedBytes > maxBytes) {
          log.warn(`[${accountId}] base64 media too large for ${msg.messageId}`);
          throw new Error("base64 media exceeds maxBytes limit");
        }
        buffer = Buffer.from(base64Data, "base64");
      } else {
        const fetched = await core.channel.media.fetchRemoteMedia({
          url: mediaUrl,
          filePathHint: mediaUrl,
          maxBytes,
        });
        buffer = fetched.buffer;
        contentTypeHint = fetched.contentType;
      }

      const mime = await detectMime({ buffer, headerMime: contentTypeHint, filePath: mediaUrl });
      const saved = await core.channel.media.saveMediaBuffer(
        buffer,
        mime ?? contentTypeHint,
        "inbound",
        maxBytes,
      );
      resolvedMediaPayload = buildMediaPayload([{ path: saved.path, contentType: saved.contentType }]);
    } catch (err) {
      log.warn(
        `[${accountId}] media localization failed for ${msg.messageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- Route ----
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: chatType, id: peerId },
  });

  // ---- Build ctxPayload ----
  const fromLabel = msg.isGroup ? `socket-chat:room:${peerId}` : `socket-chat:${msg.senderId}`;
  const toLabel = `socket-chat:${replyTarget}`;
  const conversationLabel = msg.isGroup
    ? (msg.groupName ?? peerId)
    : (msg.senderName || msg.senderId);

  const storePath = core.channel.session.resolveStorePath(undefined, { agentId: route.agentId });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: msg.content || (msg.url ?? ""),
    BodyForAgent: body,
    CommandBody: body,
    ...resolvedMediaPayload,
    From: fromLabel,
    To: toLabel,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    SenderName: msg.senderName || undefined,
    SenderId: msg.senderId,
    ChatType: chatType,
    ConversationLabel: conversationLabel,
    Timestamp: msg.timestamp,
    MessageSid: msg.messageId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: toLabel,
    ...(msg.isGroup ? { GroupSubject: msg.groupName ?? peerId } : {}),
  });

  // ---- Dispatch ----
  await dispatchInboundReplyWithBase({
    cfg: config,
    channel: CHANNEL_ID,
    accountId,
    route,
    storePath,
    ctxPayload,
    core,
    deliver: async (payload: OutboundReplyPayload) => {
      await deliverFormattedTextWithAttachments({
        payload,
        send: async ({ text }) => {
          if (!text) return;
          await sendReply(replyTarget, text);
          statusSink?.({ lastOutboundAt: Date.now() });
        },
      });
    },
    onRecordError: (err) => {
      log.error(`[${accountId}] failed updating session meta: ${String(err)}`);
    },
    onDispatchError: (err, info) => {
      log.error(`[${accountId}] socket-chat ${info.kind} reply failed: ${String(err)}`);
    },
  });
}
```

- [ ] **Step 2: Run tests (existing `inbound.test.ts` will fail — expected)**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run src/inbound.test.ts 2>&1 | head -60
```

Expected failure: tests call `handleInboundMessage` (old name) and mock `ctx.channelRuntime`. Next task fixes tests.

---

## Task 6: Update `src/mqtt-client.ts` — new calling convention

**Files:**
- Modify: `src/mqtt-client.ts`

- [ ] **Step 1: Import `createAccountStatusSink` and the new inbound handler**

Change imports at the top of `src/mqtt-client.ts`:

```ts
// Remove:
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
import { handleInboundMessage } from "./inbound.js";

// Add:
import { createAccountStatusSink } from "./runtime-api.js";
import { handleSocketChatInbound } from "./inbound.js";
import type { CoreConfig } from "./config.js";
```

- [ ] **Step 2: Update `monitorSocketChatProviderWithRegistry` signature and body**

The function keeps `ctx: ChannelGatewayContext` as its param (called from `channel.ts`). Inside, create a `statusSink` and pass it to `handleSocketChatInbound` instead of passing `ctx`:

```ts
export async function monitorSocketChatProviderWithRegistry(params: {
  account: ResolvedSocketChatAccount;
  accountId: string;
  ctx: ChannelGatewayContext<ResolvedSocketChatAccount>;
  log: LogSink;
}): Promise<void> {
  const { account, accountId, ctx, log } = params;
  const { abortSignal } = ctx;

  // Create typed status sink (replaces ctx.setStatus calls)
  const statusSink = createAccountStatusSink({
    accountId,
    setStatus: ctx.setStatus,
  });

  // ... (keep existing reconnect/MQTT logic unchanged) ...

  // Inside the client.on("message") handler, replace the handleInboundMessage call:
  void handleSocketChatInbound({
    msg,
    accountId,
    config: ctx.cfg as CoreConfig,
    statusSink: (patch) => statusSink.record(patch),
    log,
    sendReply: async (to: string, text: string) => {
      // buildTextPayload was deleted in Task 4 — construct the payload inline:
      const parsedTarget = parseSocketChatTarget(to);
      const payload: SocketChatOutboundPayload = {
        ...parsedTarget,
        messages: [{ type: 1, content: text }],
      };
      await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
    },
  }).catch((e: unknown) => {
    log.error(
      `[${accountId}] handleSocketChatInbound error: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}
```

Note: `statusSink.record` is the method on the object returned by `createAccountStatusSink`. Check its actual API by reading `openclaw/src/plugin-sdk/channel-lifecycle.ts` — adjust the call if the method name differs.

Also: the `buildTextPayload` call inside `monitorSocketChatProviderWithRegistry` (for the `sendReply` callback) needs to be renamed. Since `buildTextPayload` is deleted from `outbound.ts` (Task 4), use `parseSocketChatTarget` directly:

```ts
// Replace the sendReply sendSocketChatMessage call helper with a local inline:
const sendTextReply = async (to: string, text: string): Promise<void> => {
  const parsedTarget = parseSocketChatTarget(to);
  const payload: SocketChatOutboundPayload = {
    ...parsedTarget,
    messages: [{ type: 1, content: text }],
  };
  await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
};
```

And `setStatus` calls (`ctx.setStatus({ accountId, ...patch })`) — replace with `statusSink.record(patch)` throughout (or keep as-is if `createAccountStatusSink` wraps `setStatus` the same way).

- [ ] **Step 3: Update `LogSink` type**

Remove:
```ts
type LogSink = NonNullable<ChannelGatewayContext["log"]>;
```

Replace with a simple local type (or import from runtime-api):
```ts
type LogSink = {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
  debug?: (m: string) => void;
};
```

---

## Task 7: Update `src/channel.ts` — fix broken imports; new outbound shape

**Files:**
- Modify: `src/channel.ts`

- [ ] **Step 1: Fix broken status helper imports**

Remove from `"openclaw/plugin-sdk"` imports:
```ts
// Remove:
import {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
} from "openclaw/plugin-sdk";
```

Add via runtime-api barrel:
```ts
// Add:
import {
  buildBaseChannelStatusSummary,
  buildBaseAccountStatusSnapshot,
  collectStatusIssuesFromLastError,
  type ChannelAccountSnapshot,
  type ChannelStatusIssue,
  type ChannelPlugin,
} from "./runtime-api.js";
```

Also remove `ChannelAccountSnapshot`, `ChannelPlugin`, `ChannelStatusIssue` from the `"openclaw/plugin-sdk"` type import (they now come from `runtime-api.js`).

- [ ] **Step 2: Fix `buildTextPayload` import in `notifyApproval`**

`buildTextPayload` is deleted from `outbound.ts`. Update the `notifyApproval` code in channel.ts:

```ts
// Remove import of buildTextPayload.
// Replace usage in notifyApproval:
notifyApproval: async ({ cfg, id }) => {
  const accountIds = listSocketChatAccountIds(cfg as CoreConfig);
  let targetAccountId = DEFAULT_ACCOUNT_ID;
  for (const aid of accountIds) {
    if (getActiveMqttClient(aid)) { targetAccountId = aid; break; }
  }
  const client = getActiveMqttClient(targetAccountId);
  const mqttConfig = getActiveMqttConfig(targetAccountId);
  if (!client || !mqttConfig) return;
  const parsedTarget = parseSocketChatTarget(id);
  const payload: SocketChatOutboundPayload = {
    ...parsedTarget,
    messages: [{ type: 1, content: "You have been approved to chat with this assistant." }],
  };
  await sendSocketChatMessage({ mqttClient: client, mqttConfig, payload });
},
```

Add `import type { SocketChatOutboundPayload } from "./types.js"` if not already present.

- [ ] **Step 3: Update `gateway.startAccount` to not pass `ctx` to monitor**

The `gateway.startAccount` can remain largely the same since `monitorSocketChatProviderWithRegistry` still accepts `ctx`. No change needed here unless there are type errors from removing `ChannelGatewayContext` import.

Keep:
```ts
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
```
This type is still exported from the main barrel.

- [ ] **Step 4: Run tests**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run 2>&1 | grep -E "(PASS|FAIL|Error)" | head -30
```

---

## Task 8: Create root-level barrels — `channel-api.ts` and `runtime-api.ts`

**Files:**
- Create: `channel-api.ts`
- Create: `runtime-api.ts`

These are thin re-export files at the package root, analogous to IRC's `channel-plugin-api.ts` and `runtime-api.ts`.

- [ ] **Step 1: Create `channel-api.ts`**

```ts
export { socketChatPlugin } from "./src/channel.js";
```

- [ ] **Step 2: Create `runtime-api.ts`**

```ts
export { setSocketChatRuntime } from "./src/runtime.js";
```

---

## Task 9: Replace `index.ts` — `defineBundledChannelEntry`

**Files:**
- Modify: `index.ts` (complete replacement)

The existing `index.ts` uses the old `OpenClawPluginApi`/`register(api)` pattern. Replace it entirely.

- [ ] **Step 1: Write new `index.ts`**

```ts
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "socket-chat",
  name: "Socket Chat",
  description: "Socket Chat channel plugin — MQTT-based IM bridge",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-api.js",
    exportName: "socketChatPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setSocketChatRuntime",
  },
});
```

Note: `"openclaw/plugin-sdk/channel-entry-contract"` is imported at runtime by the openclaw host — it does NOT need to be in `__sdk-stub__.ts` or vitest aliases because `index.ts` is the entry point loaded by the host, not by tests.

- [ ] **Step 2: Add `channel-entry-contract` subpath alias to `vitest.config.ts` if any test imports `index.ts`**

If no test imports `index.ts`, skip this. Check:

```bash
grep -r "channel-entry-contract\|from.*index" /Users/leo/project/openclaw-project/socket-chat/src --include="*.test.ts"
```

If no matches, the alias is not needed.

---

## Task 10: Update `src/inbound.test.ts` — use `setSocketChatRuntime` mock pattern

**Files:**
- Modify: `src/inbound.test.ts`

The existing tests mock `ctx.channelRuntime`. The new pattern stores the runtime via `setSocketChatRuntime`.

- [ ] **Step 1: Import `setSocketChatRuntime` and `clearSocketChatRuntime`**

Add at the top of `inbound.test.ts`:
```ts
import { setSocketChatRuntime, clearSocketChatRuntime } from "./runtime.js";
import type { PluginRuntime } from "./runtime-api.js";
```

- [ ] **Step 2: Update `MockChannelRuntime` type to match `PluginRuntime["channel"]`**

The mock now needs to match the `PluginRuntime` shape used by the new inbound:

```ts
type MockRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: ReturnType<typeof vi.fn>;
    };
    session: {
      resolveStorePath: ReturnType<typeof vi.fn>;
    };
    reply: {
      finalizeInboundContext: ReturnType<typeof vi.fn>;
    };
    media: {
      fetchRemoteMedia: ReturnType<typeof vi.fn>;
      saveMediaBuffer: ReturnType<typeof vi.fn>;
    };
  };
};
```

- [ ] **Step 3: Call `setSocketChatRuntime` in `beforeEach` / per-test**

```ts
beforeEach(() => {
  const mockRuntime: MockRuntime = {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "session-1",
          accountId: "default",
        })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/store"),
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
      },
      media: {
        fetchRemoteMedia: vi.fn(async () => ({
          buffer: Buffer.from("fake-image-data"),
          contentType: "image/jpeg",
        })),
        saveMediaBuffer: vi.fn(async () => ({
          path: "/tmp/openclaw/inbound/saved.jpg",
          contentType: "image/jpeg",
        })),
      },
    },
  };
  setSocketChatRuntime(mockRuntime as unknown as PluginRuntime);
});

afterEach(() => {
  clearSocketChatRuntime();
  vi.clearAllMocks();
});
```

- [ ] **Step 4: Update `handleInboundMessage` calls → `handleSocketChatInbound`**

Change every call in the test file:

```ts
// Before:
await handleInboundMessage({ msg, accountId, ctx, log, sendReply });

// After:
await handleSocketChatInbound({
  msg,
  accountId,
  config: cfg as CoreConfig,  // use the CoreConfig directly
  log,
  sendReply,
});
```

Remove the `ctx` and `channelRuntime` mocking from tests. The runtime is now set via `setSocketChatRuntime`.

Mock `dispatchInboundReplyWithBase` at the module level instead of `ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher`:

```ts
vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    dispatchInboundReplyWithBase: vi.fn(async () => {}),
    createChannelPairingController: vi.fn(() => ({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(async () => {}),
    })),
  };
});
```

- [ ] **Step 5: Run tests — fix remaining failures**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run src/inbound.test.ts --reporter=verbose 2>&1
```

Fix any remaining failures one by one. Common issues:
- Import name changes (`handleInboundMessage` → `handleSocketChatInbound`)
- `_resetNotifiedGroupsForTest` still works (exported from new inbound)
- Config shape differences (`ctx.cfg` → `config` as `CoreConfig`)

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run 2>&1
```

Expected: all tests pass.

---

## Task 11: Create `src/inbound.authz.test.ts` — authorization tests

**Files:**
- Create: `src/inbound.authz.test.ts`

- [ ] **Step 1: Write the authorization test file**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSocketChatInbound, _resetNotifiedGroupsForTest } from "./inbound.js";
import { setSocketChatRuntime, clearSocketChatRuntime } from "./runtime.js";
import type { PluginRuntime } from "./runtime-api.js";
import type { SocketChatInboundMessage } from "./types.js";
import type { CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

let mockDispatch: ReturnType<typeof vi.fn>;
let mockIssueChallenge: ReturnType<typeof vi.fn>;
let mockReadStore: ReturnType<typeof vi.fn>;

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    dispatchInboundReplyWithBase: (...args: unknown[]) => mockDispatch(...args),
    createChannelPairingController: () => ({
      readStoreForDmPolicy: (...args: unknown[]) => mockReadStore(...args),
      issueChallenge: (...args: unknown[]) => mockIssueChallenge(...args),
    }),
  };
});

function makeMockRuntime() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "session-1",
          accountId: "default",
        })),
      },
      session: { resolveStorePath: vi.fn(() => "/tmp/store") },
      reply: { finalizeInboundContext: vi.fn((ctx) => ctx) },
      media: {
        fetchRemoteMedia: vi.fn(async () => ({ buffer: Buffer.from("img"), contentType: "image/jpeg" })),
        saveMediaBuffer: vi.fn(async () => ({ path: "/tmp/saved.jpg", contentType: "image/jpeg" })),
      },
    },
  };
}

function makeMsg(overrides: Partial<SocketChatInboundMessage> = {}): SocketChatInboundMessage {
  return {
    content: "hello",
    robotId: "robot_abc",
    senderId: "wxid_sender",
    senderName: "Alice",
    isGroup: false,
    timestamp: Date.now(),
    messageId: "msg_001",
    ...overrides,
  };
}

function makeCfg(overrides: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      "socket-chat": {
        apiKey: "test-key",
        dmPolicy: "pairing",
        ...overrides,
      },
    },
  } as unknown as CoreConfig;
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const sendReply = vi.fn(async () => {});

beforeEach(() => {
  mockDispatch = vi.fn(async () => {});
  mockIssueChallenge = vi.fn(async () => {});
  mockReadStore = vi.fn(async () => []);
  setSocketChatRuntime(makeMockRuntime() as unknown as PluginRuntime);
  _resetNotifiedGroupsForTest();
  vi.clearAllMocks();
  mockDispatch = vi.fn(async () => {});
  mockIssueChallenge = vi.fn(async () => {});
  mockReadStore = vi.fn(async () => []);
});

afterEach(() => {
  clearSocketChatRuntime();
});

// ---------------------------------------------------------------------------
// DM access control
// ---------------------------------------------------------------------------

describe("DM policy: open", () => {
  it("allows any sender", async () => {
    const cfg = makeCfg({ dmPolicy: "open" });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

describe("DM policy: allowlist", () => {
  it("allows sender in allowFrom list", async () => {
    const cfg = makeCfg({ dmPolicy: "allowlist", allowFrom: ["wxid_sender"] });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("blocks sender not in allowFrom list", async () => {
    const cfg = makeCfg({ dmPolicy: "allowlist", allowFrom: ["wxid_other"] });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("allows wildcard *", async () => {
    const cfg = makeCfg({ dmPolicy: "allowlist", allowFrom: ["*"] });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

describe("DM policy: pairing", () => {
  it("allows sender in pairing store", async () => {
    mockReadStore.mockResolvedValue(["wxid_sender"]);
    const cfg = makeCfg({ dmPolicy: "pairing" });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
    expect(mockIssueChallenge).not.toHaveBeenCalled();
  });

  it("issues pairing challenge for unknown sender", async () => {
    mockReadStore.mockResolvedValue([]);
    const cfg = makeCfg({ dmPolicy: "pairing" });
    await handleSocketChatInbound({ msg: makeMsg(), accountId: "default", config: cfg, log, sendReply });
    expect(mockIssueChallenge).toHaveBeenCalledOnce();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group access control
// ---------------------------------------------------------------------------

describe("Group messages skip DM policy", () => {
  it("dispatches group messages regardless of dmPolicy", async () => {
    // requireMention is a config field, not a message field.
    // Set requireMention=false in config so the mention check doesn't block.
    const cfg = makeCfg({ dmPolicy: "allowlist", allowFrom: [], requireMention: false });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: false,  // mention check skipped because requireMention=false in config
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

describe("Group policy: groupPolicy=allowlist", () => {
  it("blocks group not in groups list", async () => {
    const cfg = makeCfg({ groupPolicy: "allowlist", groups: ["other@chatroom"] });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: true,
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("allows group in groups list", async () => {
    const cfg = makeCfg({ groupPolicy: "allowlist", groups: ["17581395450@chatroom"] });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: true,
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});

describe("Group mention: requireMention=true (default)", () => {
  it("blocks group message without @mention", async () => {
    const cfg = makeCfg({ requireMention: true });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: false,
      content: "hello everyone",
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("allows group message with isGroupMention=true", async () => {
    const cfg = makeCfg({ requireMention: true });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: true,
      robotId: "robot_abc",
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });

  it("allows group message with @robotId in content (format: 17581395450@chatroom)", async () => {
    const cfg = makeCfg({ requireMention: true });
    const msg = makeMsg({
      isGroup: true,
      groupId: "17581395450@chatroom",
      isGroupMention: false,
      robotId: "robot_abc",
      content: "@robot_abc hello",
    });
    await handleSocketChatInbound({ msg, accountId: "default", config: cfg, log, sendReply });
    expect(mockDispatch).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the new test file**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run src/inbound.authz.test.ts --reporter=verbose 2>&1
```

Expected: all tests pass.

- [ ] **Step 3: Run the full test suite**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run 2>&1
```

Expected: all tests pass.

---

## Final Verification

- [ ] **Run full test suite one final time**

```bash
cd /Users/leo/project/openclaw-project/socket-chat
npx vitest run 2>&1
```

Expected: all tests pass, no `Error` in output.

- [ ] **Verify no deep openclaw source imports in production files**

```bash
grep -r "openclaw/src" /Users/leo/project/openclaw-project/socket-chat/src \
  --include="*.ts" \
  --exclude="__sdk-stub__.ts" \
  --exclude="*.test.ts"
```

Expected: no matches. Production files should only import `openclaw/plugin-sdk/*` or local relative paths.

- [ ] **Verify `index.ts`, `channel-api.ts`, `runtime-api.ts` exist at package root**

```bash
ls /Users/leo/project/openclaw-project/socket-chat/{index,channel-api,runtime-api}.ts
```

Expected: all three files present.
