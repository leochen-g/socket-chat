import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleInboundMessage, _resetNotifiedGroupsForTest } from "./inbound.js";
import type { SocketChatInboundMessage } from "./types.js";
import type { CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

type MockChannelRuntime = {
  pairing: {
    readAllowFromStore: ReturnType<typeof vi.fn>;
    upsertPairingRequest: ReturnType<typeof vi.fn>;
    buildPairingReply: ReturnType<typeof vi.fn>;
  };
  reply: {
    finalizeInboundContext: ReturnType<typeof vi.fn>;
    dispatchReplyWithBufferedBlockDispatcher: ReturnType<typeof vi.fn>;
  };
  routing: {
    resolveAgentRoute: ReturnType<typeof vi.fn>;
  };
  session: {
    resolveStorePath: ReturnType<typeof vi.fn>;
    recordInboundSession: ReturnType<typeof vi.fn>;
  };
  activity: {
    record: ReturnType<typeof vi.fn>;
  };
};

function makeMockRuntime(overrides: Partial<MockChannelRuntime> = {}): MockChannelRuntime {
  return {
    pairing: {
      readAllowFromStore: vi.fn(async () => []),
      upsertPairingRequest: vi.fn(async () => ({ code: "CODE123", created: true })),
      buildPairingReply: vi.fn(() => "Please pair with code: CODE123"),
      ...overrides.pairing,
    },
    reply: {
      finalizeInboundContext: vi.fn((ctx) => ctx),
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      ...overrides.reply,
    },
    routing: {
      resolveAgentRoute: vi.fn(() => ({
        agentId: "agent-1",
        sessionKey: "session-1",
        accountId: "default",
      })),
      ...overrides.routing,
    },
    session: {
      resolveStorePath: vi.fn(() => "/tmp/store"),
      recordInboundSession: vi.fn(async () => {}),
      ...overrides.session,
    },
    activity: {
      record: vi.fn(),
      ...overrides.activity,
    },
  };
}

function makeCtx(
  runtime: MockChannelRuntime,
  cfgOverride: CoreConfig = {
    channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com" } },
  },
) {
  return {
    channelRuntime: runtime,
    cfg: cfgOverride,
    abortSignal: new AbortController().signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setStatus: vi.fn(),
    account: { accountId: "default", apiKey: "k", apiBaseUrl: "https://x.com", name: undefined, enabled: true, config: {} },
  };
}

// ---------------------------------------------------------------------------
// DM policy: open
// ---------------------------------------------------------------------------

describe("handleInboundMessage — dmPolicy=open", () => {
  it("dispatches AI reply when dmPolicy is open", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" },
      },
    });
    const sendReply = vi.fn(async () => {});

    await handleInboundMessage({
      msg: makeMsg(),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply,
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(sendReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DM policy: pairing
// ---------------------------------------------------------------------------

describe("handleInboundMessage — dmPolicy=pairing", () => {
  it("blocks unknown sender and sends pairing message on first request", async () => {
    const runtime = makeMockRuntime();
    // Pairing store is empty — sender is unknown
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "pairing" },
      },
    });
    const sendReply = vi.fn(async () => {});

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_unknown" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply,
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtime.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "wxid_unknown", channel: "socket-chat" }),
    );
    expect(sendReply).toHaveBeenCalledOnce();
  });

  it("allows sender present in pairing store", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue(["wxid_approved"]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "pairing" },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_approved" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("allows sender present in config allowFrom", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          dmPolicy: "pairing",
          allowFrom: ["wxid_allowed"],
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_allowed" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("does not send second pairing message when request already exists", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);
    // Simulates already-created pairing request (created=false)
    runtime.pairing.upsertPairingRequest.mockResolvedValue({ code: "CODE123", created: false });

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "pairing" },
      },
    });
    const sendReply = vi.fn(async () => {});

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_pending" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply,
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    // No reply because created=false
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in allowFrom", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          dmPolicy: "pairing",
          allowFrom: ["*"],
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_anyone" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// DM policy: allowlist
// ---------------------------------------------------------------------------

describe("handleInboundMessage — dmPolicy=allowlist", () => {
  it("blocks sender not in allowFrom (no pairing request sent)", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          dmPolicy: "allowlist",
          allowFrom: ["wxid_allowed"],
        },
      },
    });
    const sendReply = vi.fn(async () => {});

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_stranger" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply,
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(runtime.pairing.upsertPairingRequest).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows sender in allowFrom", async () => {
    const runtime = makeMockRuntime();
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          dmPolicy: "allowlist",
          allowFrom: ["wxid_allowed"],
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({ senderId: "wxid_allowed" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Group messages
// ---------------------------------------------------------------------------

describe("handleInboundMessage — group messages", () => {
  it("dispatches AI reply for group message with isGroupMention=true (no @text needed)", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          requireMention: true,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        isGroupMention: true,
        content: "hello group (no @text in content)",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("skips group message when isGroupMention=false and no @text", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          requireMention: true,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        isGroupMention: false,
        content: "just chatting",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("dispatches AI reply for group message mentioning robotId", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          requireMention: true,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "@robot_abc hello group",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("skips group message not mentioning bot when requireMention=true", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          requireMention: true,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "just chatting without mention",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("dispatches group message without mention when requireMention=false", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          requireMention: false,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "no mention needed",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("skips DM policy check for group messages", async () => {
    const runtime = makeMockRuntime();
    // pairing store empty, but message is group — should not block
    runtime.pairing.readAllowFromStore.mockResolvedValue([]);

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": {
          apiKey: "k",
          apiBaseUrl: "https://x.com",
          dmPolicy: "pairing",
          requireMention: false,
        },
      },
    });

    await handleInboundMessage({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "group message",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    // DM pairing check should be skipped; dispatch should happen
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
    expect(runtime.pairing.upsertPairingRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Media messages
// ---------------------------------------------------------------------------

describe("handleInboundMessage — media messages", () => {
  it("passes MediaUrl fields when msg has an HTTP url (image)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    await handleInboundMessage({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "【图片消息】\n文件名：img.jpg\n下载链接：https://oss.example.com/img.jpg",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: "https://oss.example.com/img.jpg",
        MediaUrls: ["https://oss.example.com/img.jpg"],
        MediaPath: "https://oss.example.com/img.jpg",
        MediaType: "image/jpeg",
      }),
    );
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("passes MediaUrl fields when msg has an HTTP url (video)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    await handleInboundMessage({
      msg: makeMsg({
        type: "视频",
        url: "https://oss.example.com/video.mp4",
        content: "【视频消息】\n文件名：video.mp4\n下载链接：https://oss.example.com/video.mp4",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: "https://oss.example.com/video.mp4",
        MediaType: "video/mp4",
      }),
    );
  });

  it("does NOT pass MediaUrl for base64 url (no OSS configured)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    await handleInboundMessage({
      msg: makeMsg({
        type: "图片",
        url: "data:image/jpeg;base64,/9j/4AAQ...",
        content: "【图片消息】\n文件名：img.jpg\n文件大小：12345 bytes",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    const callArg = runtime.reply.finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty("MediaUrl");
    expect(callArg).not.toHaveProperty("MediaUrls");
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("does not skip image-only message (content empty, url present)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    await handleInboundMessage({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "",
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    // Should not be skipped — dispatches even without text content
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("uses content as body when both content and url are present", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    const content = "【图片消息】\n文件名：img.jpg\n下载链接：https://oss.example.com/img.jpg";

    await handleInboundMessage({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content,
      }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Body: content, BodyForAgent: content }),
    );
  });

  it("falls back to <media:type> placeholder as body when content is empty", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" } },
    });

    await handleInboundMessage({
      msg: makeMsg({ type: "图片", url: "https://oss.example.com/img.jpg", content: "" }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Body: "<media:图片>", BodyForAgent: "<media:图片>" }),
    );
  });

  it("skips message when both content and url are absent", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime);

    await handleInboundMessage({
      msg: makeMsg({ content: "", url: undefined }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("handleInboundMessage — edge cases", () => {
  it("skips empty message content", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime);

    await handleInboundMessage({
      msg: makeMsg({ content: "   " }),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("handles missing channelRuntime gracefully", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      handleInboundMessage({
        msg: makeMsg(),
        accountId: "default",
        ctx: { channelRuntime: null, cfg: {} } as never,
        log,
        sendReply: vi.fn(async () => {}),
      }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("channelRuntime not available"),
    );
  });

  it("records inbound and outbound activity on success", async () => {
    const runtime = makeMockRuntime();

    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", dmPolicy: "open" },
      },
    });

    await handleInboundMessage({
      msg: makeMsg(),
      accountId: "default",
      ctx: ctx as never,
      log: ctx.log,
      sendReply: vi.fn(async () => {}),
    });

    expect(runtime.activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "inbound", channel: "socket-chat" }),
    );
    expect(runtime.activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "outbound", channel: "socket-chat" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Group access control — tier 1 (groupId) + tier 2 (sender)
// ---------------------------------------------------------------------------

describe("handleInboundMessage — group access control (tier 1: groupId)", () => {
  beforeEach(() => {
    _resetNotifiedGroupsForTest();
  });

  it("allows all groups when groupPolicy=open (default)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("blocks all groups when groupPolicy=disabled (no notification)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "disabled" } },
    });
    const sendReply = vi.fn(async () => {});
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply,
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows group in allowlist when groupPolicy=allowlist", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: {
        "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "allowlist", groups: ["R:allowed_group"], requireMention: false },
      },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:allowed_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("blocks unlisted group and sends one-time notification", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "allowlist", groups: ["R:allowed_group"] } },
    });
    const sendReply = vi.fn(async () => {});
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:other_group", groupName: "测试群", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply,
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledOnce();
    expect(sendReply.mock.calls[0]?.[0]).toBe("group:R:other_group");
    expect(sendReply.mock.calls[0]?.[1]).toContain("R:other_group");
  });

  it("does NOT send second notification for same blocked group", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "allowlist", groups: ["R:allowed_group"] } },
    });
    const sendReply = vi.fn(async () => {});
    const msg = makeMsg({ isGroup: true, groupId: "R:notify_once_group", isGroupMention: true });
    await handleInboundMessage({ msg, accountId: "default", ctx: ctx as never, log: ctx.log, sendReply });
    await handleInboundMessage({ msg, accountId: "default", ctx: ctx as never, log: ctx.log, sendReply });
    expect(sendReply).toHaveBeenCalledOnce();
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("blocks when groupPolicy=allowlist and groups is empty (no notification)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "allowlist", groups: [] } },
    });
    const sendReply = vi.fn(async () => {});
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply,
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in groups list", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupPolicy: "allowlist", groups: ["*"], requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});

describe("handleInboundMessage — group access control (tier 2: sender)", () => {
  beforeEach(() => {
    _resetNotifiedGroupsForTest();
  });

  it("allows all senders when groupAllowFrom is empty", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_anyone", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("allows sender matching groupAllowFrom by ID", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupAllowFrom: ["wxid_allowed"], requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_allowed", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("allows sender matching groupAllowFrom by name (case-insensitive)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupAllowFrom: ["alice"], requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_unknown", senderName: "Alice", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });

  it("blocks sender not in groupAllowFrom (silent drop)", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupAllowFrom: ["wxid_allowed"], requireMention: false } },
    });
    const sendReply = vi.fn(async () => {});
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_stranger", senderName: "Stranger", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply,
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in groupAllowFrom", async () => {
    const runtime = makeMockRuntime();
    const ctx = makeCtx(runtime, {
      channels: { "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com", groupAllowFrom: ["*"], requireMention: false } },
    });
    await handleInboundMessage({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_anyone", isGroupMention: true }),
      accountId: "default", ctx: ctx as never, log: ctx.log, sendReply: vi.fn(async () => {}),
    });
    expect(runtime.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  });
});
