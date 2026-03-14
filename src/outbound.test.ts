import { describe, expect, it } from "vitest";
import {
  buildMediaPayload,
  buildTextPayload,
  looksLikeSocketChatTargetId,
  normalizeSocketChatTarget,
  parseSocketChatTarget,
} from "./outbound.js";

// ---------------------------------------------------------------------------
// parseSocketChatTarget
// ---------------------------------------------------------------------------

describe("parseSocketChatTarget", () => {
  it("parses a direct contact ID", () => {
    const result = parseSocketChatTarget("wxid_abc123");
    expect(result).toEqual({ isGroup: false, contactId: "wxid_abc123" });
  });

  it("parses a group target without mentions", () => {
    const result = parseSocketChatTarget("group:17581395450@chatroom");
    expect(result).toEqual({ isGroup: true, groupId: "17581395450@chatroom" });
  });

  it("parses a group target with single mention", () => {
    const result = parseSocketChatTarget("group:17581395450@chatroom|wxid_a");
    expect(result).toEqual({ isGroup: true, groupId: "17581395450@chatroom", mentionIds: ["wxid_a"] });
  });

  it("parses a group target with multiple mentions", () => {
    const result = parseSocketChatTarget("group:17581395450@chatroom|wxid_a,wxid_b,wxid_c");
    expect(result).toEqual({
      isGroup: true,
      groupId: "17581395450@chatroom",
      mentionIds: ["wxid_a", "wxid_b", "wxid_c"],
    });
  });

  it("trims whitespace from target string", () => {
    const result = parseSocketChatTarget("  wxid_trim  ");
    expect(result).toEqual({ isGroup: false, contactId: "wxid_trim" });
  });

  it("filters empty mention ids", () => {
    const result = parseSocketChatTarget("group:17581395450@chatroom|wxid_a,,wxid_b");
    expect(result.isGroup).toBe(true);
    if (result.isGroup) {
      expect(result.mentionIds).toEqual(["wxid_a", "wxid_b"]);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeSocketChatTarget
// ---------------------------------------------------------------------------

describe("normalizeSocketChatTarget", () => {
  it("returns the target unchanged for native IDs", () => {
    expect(normalizeSocketChatTarget("wxid_abc")).toBe("wxid_abc");
    expect(normalizeSocketChatTarget("group:17581395450@chatroom")).toBe("group:17581395450@chatroom");
    expect(normalizeSocketChatTarget("group:17581395450@chatroom|wxid_a")).toBe("group:17581395450@chatroom|wxid_a");
  });

  it("strips shellbot-chat: prefix (case-insensitive)", () => {
    expect(normalizeSocketChatTarget("shellbot-chat:wxid_abc")).toBe("wxid_abc");
    expect(normalizeSocketChatTarget("Shellbot-Chat:wxid_abc")).toBe("wxid_abc");
    expect(normalizeSocketChatTarget("SHELLBOT-CHAT:wxid_abc")).toBe("wxid_abc");
  });

  it("returns undefined for empty/whitespace-only strings", () => {
    expect(normalizeSocketChatTarget("")).toBeUndefined();
    expect(normalizeSocketChatTarget("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSocketChatTarget("  wxid_abc  ")).toBe("wxid_abc");
  });
});

// ---------------------------------------------------------------------------
// looksLikeSocketChatTargetId
// ---------------------------------------------------------------------------

describe("looksLikeSocketChatTargetId", () => {
  it("accepts any non-empty id", () => {
    expect(looksLikeSocketChatTargetId("wxid_abc123")).toBe(true);
    expect(looksLikeSocketChatTargetId("roomid_xyz")).toBe(true);
    expect(looksLikeSocketChatTargetId("group:roomid_xxx")).toBe(true);
    expect(looksLikeSocketChatTargetId("alice")).toBe(true);
    expect(looksLikeSocketChatTargetId("user@example.com")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(looksLikeSocketChatTargetId("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(looksLikeSocketChatTargetId("   ")).toBe(false);
  });

  it("trims before checking", () => {
    expect(looksLikeSocketChatTargetId("  wxid_abc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildTextPayload
// ---------------------------------------------------------------------------

describe("buildTextPayload", () => {
  it("builds a DM text payload", () => {
    const payload = buildTextPayload("wxid_abc", "hello");
    expect(payload.isGroup).toBe(false);
    expect(payload.contactId).toBe("wxid_abc");
    expect(payload.messages).toEqual([{ type: 1, content: "hello" }]);
    expect(payload.mentionIds).toBeUndefined();
  });

  it("builds a group text payload", () => {
    const payload = buildTextPayload("group:17581395450@chatroom", "hi group");
    expect(payload.isGroup).toBe(true);
    expect(payload.groupId).toBe("17581395450@chatroom");
    expect(payload.messages).toEqual([{ type: 1, content: "hi group" }]);
  });

  it("extracts mentions from group target string", () => {
    const payload = buildTextPayload("group:17581395450@chatroom|wxid_a,wxid_b", "hi");
    expect(payload.mentionIds).toEqual(["wxid_a", "wxid_b"]);
  });

  it("allows explicit override of mentionIds", () => {
    const payload = buildTextPayload("group:17581395450@chatroom", "hi", { mentionIds: ["wxid_override"] });
    expect(payload.mentionIds).toEqual(["wxid_override"]);
  });

  it("sets mentionIds to undefined when empty", () => {
    const payload = buildTextPayload("group:17581395450@chatroom", "hi", { mentionIds: [] });
    expect(payload.mentionIds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildMediaPayload
// ---------------------------------------------------------------------------

describe("buildMediaPayload", () => {
  it("builds a media-only payload without caption", () => {
    const payload = buildMediaPayload("wxid_abc", "https://img.example.com/photo.jpg");
    expect(payload.isGroup).toBe(false);
    expect(payload.messages).toEqual([
      { type: 2, url: "https://img.example.com/photo.jpg" },
    ]);
  });

  it("includes caption text before image when provided", () => {
    const payload = buildMediaPayload("wxid_abc", "https://img.example.com/photo.jpg", "Look at this");
    expect(payload.messages).toEqual([
      { type: 1, content: "Look at this" },
      { type: 2, url: "https://img.example.com/photo.jpg" },
    ]);
  });

  it("skips empty caption", () => {
    const payload = buildMediaPayload("wxid_abc", "https://img.example.com/photo.jpg", "   ");
    expect(payload.messages).toEqual([
      { type: 2, url: "https://img.example.com/photo.jpg" },
    ]);
  });

  it("builds group media payload", () => {
    const payload = buildMediaPayload("group:roomid_xxx", "https://img.example.com/photo.jpg");
    expect(payload.isGroup).toBe(true);
    expect(payload.groupId).toBe("roomid_xxx");
  });
});
