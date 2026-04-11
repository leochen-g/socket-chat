import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { dispatchInboundReplyWithBase, createChannelPairingController } from "./runtime-api.js";
import { setSocketChatRuntime, clearSocketChatRuntime } from "./runtime.js";
import { handleSocketChatInbound, _resetNotifiedGroupsForTest } from "./inbound.js";
import type { SocketChatInboundMessage } from "./types.js";
import type { CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./runtime-api.js", () => {
  return {
    dispatchInboundReplyWithBase: vi.fn(async () => {}),
    createChannelPairingController: vi.fn(),
    deliverFormattedTextWithAttachments: vi.fn(async () => true),
    resolveAllowlistMatchByCandidates: vi.fn(
      ({ allowList, candidates }: { allowList: string[]; candidates: { value: string }[] }) => {
        const allowed = allowList.some(
          (rule) => rule === "*" || candidates.some((c) => c.value === rule),
        );
        return { allowed, matchedRule: undefined };
      },
    ),
    resolveChannelMediaMaxBytes: vi.fn(
      ({
        cfg,
        resolveChannelLimitMb,
        accountId,
      }: {
        cfg: unknown;
        resolveChannelLimitMb: (args: { cfg: unknown; accountId: string }) => number | undefined;
        accountId: string;
      }) => {
        const mb = resolveChannelLimitMb({ cfg, accountId });
        return mb !== undefined ? mb * 1024 * 1024 : undefined;
      },
    ),
    detectMime: vi.fn(async ({ headerMime }: { headerMime?: string }) => headerMime),
    buildMediaPayload: vi.fn(
      (items: Array<{ path: string; contentType?: string }>) => {
        const item = items[0];
        if (!item) return {};
        return {
          MediaPath: item.path,
          MediaUrl: item.path,
          MediaPaths: [item.path],
          MediaUrls: [item.path],
          MediaType: item.contentType,
          MediaTypes: [item.contentType],
        };
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
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

function makeConfig(channelCfg: Record<string, unknown> = {}): CoreConfig {
  return {
    channels: {
      "socket-chat": {
        apiKey: "k",
        apiBaseUrl: "https://x.com",
        ...channelCfg,
      },
    },
  } as unknown as CoreConfig;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

type MockCore = {
  channel: {
    routing: { resolveAgentRoute: ReturnType<typeof vi.fn> };
    session: { resolveStorePath: ReturnType<typeof vi.fn> };
    reply: { finalizeInboundContext: ReturnType<typeof vi.fn> };
    media: {
      fetchRemoteMedia: ReturnType<typeof vi.fn>;
      saveMediaBuffer: ReturnType<typeof vi.fn>;
    };
    pairing: {
      readAllowFromStore: ReturnType<typeof vi.fn>;
      upsertPairingRequest: ReturnType<typeof vi.fn>;
    };
  };
};

function makeMockCore(overrides: Partial<MockCore["channel"]> = {}): MockCore {
  return {
    channel: {
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
        ...overrides.session,
      },
      reply: {
        finalizeInboundContext: vi.fn((ctx) => ctx),
        ...overrides.reply,
      },
      media: {
        fetchRemoteMedia: vi.fn(async () => ({
          buffer: Buffer.from("fake-image-data"),
          contentType: "image/jpeg",
        })),
        saveMediaBuffer: vi.fn(async () => ({
          path: "/tmp/openclaw/inbound/saved-img.jpg",
          contentType: "image/jpeg",
        })),
        ...overrides.media,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "CODE123", created: true })),
        ...overrides.pairing,
      },
    },
  };
}

function makeDefaultPairingController(overrides: {
  readAllowFromStore?: () => Promise<string[]>;
  issueChallenge?: (params: { sendPairingReply: (text: string) => Promise<void> }) => Promise<void>;
} = {}) {
  return {
    readAllowFromStore: vi.fn(overrides.readAllowFromStore ?? (async () => [])),
    issueChallenge: vi.fn(overrides.issueChallenge ?? (async () => {})),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let mockCore: MockCore;

beforeEach(() => {
  mockCore = makeMockCore();
  setSocketChatRuntime(mockCore as never);
  vi.mocked(dispatchInboundReplyWithBase).mockClear();
  vi.mocked(dispatchInboundReplyWithBase).mockResolvedValue(undefined as never);
  // Default pairing controller: nobody in store, issueChallenge is no-op
  vi.mocked(createChannelPairingController).mockReturnValue(
    makeDefaultPairingController() as never,
  );
});

afterEach(() => {
  clearSocketChatRuntime();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// DM policy: open
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — dmPolicy=open", () => {
  it("dispatches AI reply when dmPolicy is open", async () => {
    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg(),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply,
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
    expect(sendReply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DM policy: pairing
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — dmPolicy=pairing", () => {
  it("blocks unknown sender and sends pairing message on first request", async () => {
    const mockController = makeDefaultPairingController({
      readAllowFromStore: async () => [],
      issueChallenge: async ({ sendPairingReply }) => {
        await sendPairingReply("Please pair with code: CODE123");
      },
    });
    vi.mocked(createChannelPairingController).mockReturnValue(mockController as never);

    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_unknown" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing" }),
      log: makeLog(),
      sendReply,
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(mockController.issueChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "wxid_unknown" }),
    );
    expect(sendReply).toHaveBeenCalledOnce();
  });

  it("allows sender present in pairing store", async () => {
    vi.mocked(createChannelPairingController).mockReturnValue(
      makeDefaultPairingController({ readAllowFromStore: async () => ["wxid_approved"] }) as never,
    );

    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_approved" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("allows sender present in config allowFrom", async () => {
    // Store is empty; allowed via config
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_allowed" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing", allowFrom: ["wxid_allowed"] }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("does not send pairing message when issueChallenge resolves without calling sendPairingReply", async () => {
    // Simulates already-pending request where issueChallenge doesn't send another message
    vi.mocked(createChannelPairingController).mockReturnValue(
      makeDefaultPairingController({
        readAllowFromStore: async () => [],
        issueChallenge: async () => {}, // no-op — doesn't call sendPairingReply
      }) as never,
    );

    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_pending" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing" }),
      log: makeLog(),
      sendReply,
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in allowFrom", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_anyone" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing", allowFrom: ["*"] }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// DM policy: allowlist
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — dmPolicy=allowlist", () => {
  it("blocks sender not in allowFrom (no pairing request sent)", async () => {
    const mockController = makeDefaultPairingController({
      readAllowFromStore: async () => [],
    });
    vi.mocked(createChannelPairingController).mockReturnValue(mockController as never);

    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_stranger" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "allowlist", allowFrom: ["wxid_allowed"] }),
      log: makeLog(),
      sendReply,
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(mockController.issueChallenge).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows sender in allowFrom", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ senderId: "wxid_allowed" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "allowlist", allowFrom: ["wxid_allowed"] }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Group messages
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — group messages", () => {
  it("dispatches AI reply for group message with isGroupMention=true (no @text needed)", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        isGroupMention: true,
        content: "hello group (no @text in content)",
      }),
      accountId: "default",
      config: makeConfig({ requireMention: true }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("skips group message when isGroupMention=false and no @text", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        isGroupMention: false,
        content: "just chatting",
      }),
      accountId: "default",
      config: makeConfig({ requireMention: true }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
  });

  it("dispatches AI reply for group message mentioning robotId", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "@robot_abc hello group",
      }),
      accountId: "default",
      config: makeConfig({ requireMention: true }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("skips group message not mentioning bot when requireMention=true", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "just chatting without mention",
      }),
      accountId: "default",
      config: makeConfig({ requireMention: true }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
  });

  it("dispatches group message without mention when requireMention=false", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "no mention needed",
      }),
      accountId: "default",
      config: makeConfig({ requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("skips DM policy check for group messages", async () => {
    const mockController = makeDefaultPairingController({
      readAllowFromStore: async () => [], // empty store
    });
    vi.mocked(createChannelPairingController).mockReturnValue(mockController as never);

    await handleSocketChatInbound({
      msg: makeMsg({
        isGroup: true,
        groupId: "roomid_group1",
        robotId: "robot_abc",
        content: "group message",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "pairing", requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    // DM pairing check is skipped; dispatch should happen
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
    expect(mockController.issueChallenge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Media messages
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — media messages", () => {
  it("downloads image URL and passes local path as MediaPath/MediaUrl", async () => {
    mockCore.channel.media.saveMediaBuffer.mockResolvedValue({
      path: "/tmp/openclaw/inbound/img-001.jpg",
      contentType: "image/jpeg",
    });

    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "【图片消息】\n文件名：img.jpg",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.media.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://oss.example.com/img.jpg" }),
    );
    expect(mockCore.channel.media.saveMediaBuffer).toHaveBeenCalledOnce();
    expect(mockCore.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPath: "/tmp/openclaw/inbound/img-001.jpg",
        MediaUrl: "/tmp/openclaw/inbound/img-001.jpg",
        MediaPaths: ["/tmp/openclaw/inbound/img-001.jpg"],
        MediaUrls: ["/tmp/openclaw/inbound/img-001.jpg"],
        MediaType: "image/jpeg",
      }),
    );
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("downloads video URL and detects correct content type", async () => {
    mockCore.channel.media.fetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("fake-video-data"),
      contentType: "video/mp4",
    });
    mockCore.channel.media.saveMediaBuffer.mockResolvedValue({
      path: "/tmp/openclaw/inbound/video-001.mp4",
      contentType: "video/mp4",
    });

    await handleSocketChatInbound({
      msg: makeMsg({
        type: "视频",
        url: "https://oss.example.com/video.mp4",
        content: "【视频消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPath: "/tmp/openclaw/inbound/video-001.mp4",
        MediaType: "video/mp4",
      }),
    );
  });

  it("decodes base64 data URL and saves to local file", async () => {
    mockCore.channel.media.saveMediaBuffer.mockResolvedValue({
      path: "/tmp/openclaw/inbound/b64-img.jpg",
      contentType: "image/jpeg",
    });

    const fakeBase64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: `data:image/jpeg;base64,${fakeBase64}`,
        content: "【图片消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    // Should NOT call fetchRemoteMedia for data URLs
    expect(mockCore.channel.media.fetchRemoteMedia).not.toHaveBeenCalled();
    // Should call saveMediaBuffer with decoded buffer
    expect(mockCore.channel.media.saveMediaBuffer).toHaveBeenCalledOnce();
    const [savedBuf, savedMime] = mockCore.channel.media.saveMediaBuffer.mock.calls[0] as [
      Buffer,
      string,
    ];
    expect(Buffer.isBuffer(savedBuf)).toBe(true);
    expect(savedBuf.toString()).toBe("fake-jpeg-bytes");
    expect(savedMime).toBe("image/jpeg");
    // ctxPayload should carry the local path
    expect(mockCore.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaPath: "/tmp/openclaw/inbound/b64-img.jpg",
        MediaUrl: "/tmp/openclaw/inbound/b64-img.jpg",
      }),
    );
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("skips base64 media that exceeds maxBytes and continues dispatch", async () => {
    const log = makeLog();

    // ~2 MB of base64 data (each char ≈ 0.75 bytes → need > 1.4M chars)
    const bigBase64 = "A".repeat(1_500_000);
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: `data:image/jpeg;base64,${bigBase64}`,
        content: "【图片消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open", mediaMaxMb: 1 }),
      log,
      sendReply: vi.fn(async () => {}),
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("media localization failed"));
    expect(mockCore.channel.media.saveMediaBuffer).not.toHaveBeenCalled();
    // Dispatch still proceeds without media fields
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
    const callArg = mockCore.channel.reply.finalizeInboundContext.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty("MediaPath");
  });

  it("does not call fetchRemoteMedia for base64 data URLs (uses saveMediaBuffer directly)", async () => {
    const fakeBase64 = Buffer.from("img-bytes").toString("base64");
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: `data:image/jpeg;base64,${fakeBase64}`,
        content: "【图片消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.media.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mockCore.channel.media.saveMediaBuffer).toHaveBeenCalledOnce();
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("does not call fetchRemoteMedia when url is absent", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ content: "plain text, no media" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.media.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mockCore.channel.media.saveMediaBuffer).not.toHaveBeenCalled();
    const callArg = mockCore.channel.reply.finalizeInboundContext.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty("MediaPath");
  });

  it("continues dispatch and logs warning when media download fails", async () => {
    mockCore.channel.media.fetchRemoteMedia.mockRejectedValue(new Error("network timeout"));

    const log = makeLog();
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "【图片消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log,
      sendReply: vi.fn(async () => {}),
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("media localization failed"));
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
    const callArg = mockCore.channel.reply.finalizeInboundContext.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg).not.toHaveProperty("MediaPath");
    expect(callArg).not.toHaveProperty("MediaUrl");
  });

  it("continues dispatch and logs warning when saveMediaBuffer fails", async () => {
    mockCore.channel.media.saveMediaBuffer.mockRejectedValue(new Error("disk full"));

    const log = makeLog();
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "【图片消息】",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log,
      sendReply: vi.fn(async () => {}),
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("media localization failed"));
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("does not skip image-only message (content empty, url present)", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content: "",
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("uses content as body when both content and url are present", async () => {
    const content = "【图片消息】\n文件名：img.jpg\n下载链接：https://oss.example.com/img.jpg";

    await handleSocketChatInbound({
      msg: makeMsg({
        type: "图片",
        url: "https://oss.example.com/img.jpg",
        content,
      }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Body: content, BodyForAgent: content }),
    );
  });

  it("falls back to <media:type> placeholder as body when content is empty", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ type: "图片", url: "https://oss.example.com/img.jpg", content: "" }),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(mockCore.channel.reply.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ Body: "<media:图片>", BodyForAgent: "<media:图片>" }),
    );
  });

  it("skips message when both content and url are absent", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ content: "", url: undefined }),
      accountId: "default",
      config: makeConfig(),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(mockCore.channel.media.fetchRemoteMedia).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — edge cases", () => {
  it("skips empty message content", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ content: "   " }),
      accountId: "default",
      config: makeConfig(),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });

    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
  });

  it("rejects when runtime is not initialized", async () => {
    clearSocketChatRuntime(); // remove runtime injected in beforeEach

    await expect(
      handleSocketChatInbound({
        msg: makeMsg(),
        accountId: "default",
        config: makeConfig(),
        log: makeLog(),
        sendReply: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/socket-chat runtime not initialized/);
  });

  it("calls statusSink with lastInboundAt on message arrival", async () => {
    const statusSink = vi.fn();
    await handleSocketChatInbound({
      msg: makeMsg(),
      accountId: "default",
      config: makeConfig({ dmPolicy: "open" }),
      log: makeLog(),
      statusSink,
      sendReply: vi.fn(async () => {}),
    });

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lastInboundAt: expect.any(Number) }),
    );
  });
});

// ---------------------------------------------------------------------------
// Group access control — tier 1 (groupId) + tier 2 (sender)
// ---------------------------------------------------------------------------

describe("handleSocketChatInbound — group access control (tier 1: groupId)", () => {
  beforeEach(() => {
    _resetNotifiedGroupsForTest();
  });

  it("allows all groups when groupPolicy=open (default)", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("blocks all groups when groupPolicy=disabled (no notification)", async () => {
    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupPolicy: "disabled" }),
      log: makeLog(),
      sendReply,
    });
    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows group in allowlist when groupPolicy=allowlist", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:allowed_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupPolicy: "allowlist", groups: ["R:allowed_group"], requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("blocks unlisted group without sending notification", async () => {
    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:other_group", groupName: "测试群", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupPolicy: "allowlist", groups: ["R:allowed_group"] }),
      log: makeLog(),
      sendReply,
    });
    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("silently blocks repeated messages from same unlisted group", async () => {
    const sendReply = vi.fn(async () => {});
    const msg = makeMsg({ isGroup: true, groupId: "R:notify_once_group", isGroupMention: true });
    const args = {
      msg,
      accountId: "default",
      config: makeConfig({ groupPolicy: "allowlist", groups: ["R:allowed_group"] }),
      log: makeLog(),
      sendReply,
    };
    await handleSocketChatInbound(args);
    await handleSocketChatInbound(args);
    expect(sendReply).not.toHaveBeenCalled();
    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
  });

  it("blocks when groupPolicy=allowlist and groups is empty (no notification)", async () => {
    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupPolicy: "allowlist", groups: [] }),
      log: makeLog(),
      sendReply,
    });
    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in groups list", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:any_group", robotId: "robot_abc", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupPolicy: "allowlist", groups: ["*"], requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });
});

describe("handleSocketChatInbound — group access control (tier 2: sender)", () => {
  beforeEach(() => {
    _resetNotifiedGroupsForTest();
  });

  it("allows all senders when groupAllowFrom is empty", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_anyone", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("allows sender matching groupAllowFrom by ID", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_allowed", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupAllowFrom: ["wxid_allowed"], requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("allows sender matching groupAllowFrom by name (case-insensitive)", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_unknown", senderName: "Alice", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupAllowFrom: ["alice"], requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });

  it("blocks sender not in groupAllowFrom (silent drop)", async () => {
    const sendReply = vi.fn(async () => {});
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_stranger", senderName: "Stranger", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupAllowFrom: ["wxid_allowed"], requireMention: false }),
      log: makeLog(),
      sendReply,
    });
    expect(dispatchInboundReplyWithBase).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("allows wildcard '*' in groupAllowFrom", async () => {
    await handleSocketChatInbound({
      msg: makeMsg({ isGroup: true, groupId: "R:g1", senderId: "wxid_anyone", isGroupMention: true }),
      accountId: "default",
      config: makeConfig({ groupAllowFrom: ["*"], requireMention: false }),
      log: makeLog(),
      sendReply: vi.fn(async () => {}),
    });
    expect(dispatchInboundReplyWithBase).toHaveBeenCalledOnce();
  });
});
