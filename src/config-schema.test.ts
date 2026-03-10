import { describe, expect, it } from "vitest";
import { SocketChatAccountConfigSchema, SocketChatTopLevelConfigSchema } from "./config-schema.js";

describe("SocketChatAccountConfigSchema", () => {
  it("accepts a fully specified config", () => {
    const parsed = SocketChatAccountConfigSchema.parse({
      apiKey: "key123",
      apiBaseUrl: "https://example.com",
      name: "My Bot",
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: ["wxid_alice", "wxid_bob"],
      defaultTo: "wxid_alice",
      requireMention: true,
      mqttConfigTtlSec: 600,
      maxReconnectAttempts: 5,
      reconnectBaseDelayMs: 1000,
    });

    expect(parsed.apiKey).toBe("key123");
    expect(parsed.dmPolicy).toBe("pairing");
    expect(parsed.allowFrom).toEqual(["wxid_alice", "wxid_bob"]);
  });

  it("accepts an empty config (all fields optional)", () => {
    const parsed = SocketChatAccountConfigSchema.parse({});
    expect(parsed).toBeDefined();
    expect(parsed.apiKey).toBeUndefined();
  });

  it("validates dmPolicy enum values", () => {
    expect(() =>
      SocketChatAccountConfigSchema.parse({ dmPolicy: "invalid" }),
    ).toThrow();
  });

  it("accepts all valid dmPolicy values", () => {
    for (const policy of ["pairing", "open", "allowlist"] as const) {
      const parsed = SocketChatAccountConfigSchema.parse({ dmPolicy: policy });
      expect(parsed.dmPolicy).toBe(policy);
    }
  });

  it("rejects non-boolean for enabled field", () => {
    expect(() =>
      SocketChatAccountConfigSchema.parse({ enabled: "yes" }),
    ).toThrow();
  });

  it("accepts allowFrom as string array", () => {
    const parsed = SocketChatAccountConfigSchema.parse({
      allowFrom: ["wxid_abc", "wxid_def"],
    });
    expect(parsed.allowFrom).toEqual(["wxid_abc", "wxid_def"]);
  });
});

describe("SocketChatTopLevelConfigSchema", () => {
  it("accepts a multi-account config", () => {
    const parsed = SocketChatTopLevelConfigSchema.parse({
      accounts: {
        default: { apiKey: "key-default", apiBaseUrl: "https://default.com" },
        work: { apiKey: "key-work", apiBaseUrl: "https://work.com" },
      },
    });
    expect(parsed.accounts?.["default"]?.apiKey).toBe("key-default");
    expect(parsed.accounts?.["work"]?.apiKey).toBe("key-work");
  });

  it("accepts top-level fields alongside accounts map", () => {
    const parsed = SocketChatTopLevelConfigSchema.parse({
      apiKey: "top-key",
      apiBaseUrl: "https://top.com",
      accounts: {
        work: { apiKey: "work-key", apiBaseUrl: "https://work.com" },
      },
    });
    expect(parsed.apiKey).toBe("top-key");
    expect(parsed.accounts?.["work"]?.apiKey).toBe("work-key");
  });

  it("accepts config without accounts map", () => {
    const parsed = SocketChatTopLevelConfigSchema.parse({
      apiKey: "k",
      apiBaseUrl: "https://x.com",
    });
    expect(parsed.accounts).toBeUndefined();
  });
});
