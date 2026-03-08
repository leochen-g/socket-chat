import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_API_BASE_URL,
  applySocketChatAccountConfig,
  deleteSocketChatAccount,
  isSocketChatAccountConfigured,
  listSocketChatAccountIds,
  normalizeAccountId,
  resolveDefaultSocketChatAccountId,
  resolveSocketChatAccount,
  setSocketChatAccountEnabled,
} from "./config.js";
import type { CoreConfig } from "./config.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cfg(top: CoreConfig["channels"]): CoreConfig {
  return { channels: top };
}

// ---------------------------------------------------------------------------
// resolveSocketChatAccount
// ---------------------------------------------------------------------------

describe("resolveSocketChatAccount", () => {
  it("reads top-level fields as default account", () => {
    const c = cfg({
      "socket-chat": { apiKey: "k1", apiBaseUrl: "https://example.com" },
    });
    const account = resolveSocketChatAccount(c, DEFAULT_ACCOUNT_ID);
    expect(account.accountId).toBe("default");
    expect(account.apiKey).toBe("k1");
    expect(account.apiBaseUrl).toBe("https://example.com");
    expect(account.enabled).toBe(true);
  });

  it("reads named account from accounts map", () => {
    const c = cfg({
      "socket-chat": {
        apiKey: "top-key",
        accounts: {
          work: { apiKey: "work-key", apiBaseUrl: "https://work.example.com" },
        },
      },
    });
    const account = resolveSocketChatAccount(c, "work");
    expect(account.accountId).toBe("work");
    expect(account.apiKey).toBe("work-key");
    expect(account.apiBaseUrl).toBe("https://work.example.com");
  });

  it("returns empty account for unknown accountId", () => {
    const c = cfg({ "socket-chat": { apiKey: "k1" } });
    const account = resolveSocketChatAccount(c, "nonexistent");
    expect(account.accountId).toBe("nonexistent");
    expect(account.apiKey).toBeUndefined();
    expect(account.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
  });

  it("trims whitespace from apiKey and apiBaseUrl", () => {
    const c = cfg({
      "socket-chat": { apiKey: "  trimmed  ", apiBaseUrl: "  https://x.com  " },
    });
    const account = resolveSocketChatAccount(c, DEFAULT_ACCOUNT_ID);
    expect(account.apiKey).toBe("trimmed");
    expect(account.apiBaseUrl).toBe("https://x.com");
  });

  it("defaults enabled to true when not set", () => {
    const c = cfg({ "socket-chat": { apiKey: "k1" } });
    const account = resolveSocketChatAccount(c, DEFAULT_ACCOUNT_ID);
    expect(account.enabled).toBe(true);
  });

  it("respects enabled=false", () => {
    const c = cfg({ "socket-chat": { apiKey: "k1", enabled: false } });
    const account = resolveSocketChatAccount(c, DEFAULT_ACCOUNT_ID);
    expect(account.enabled).toBe(false);
  });

  it("handles empty config gracefully", () => {
    const account = resolveSocketChatAccount({}, DEFAULT_ACCOUNT_ID);
    expect(account.apiKey).toBeUndefined();
    expect(account.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(account.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSocketChatAccountConfigured
// ---------------------------------------------------------------------------

describe("isSocketChatAccountConfigured", () => {
  it("returns true when both apiKey and apiBaseUrl are set", () => {
    const account = resolveSocketChatAccount(
      cfg({ "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com" } }),
      DEFAULT_ACCOUNT_ID,
    );
    expect(isSocketChatAccountConfigured(account)).toBe(true);
  });

  it("returns false when apiKey is missing", () => {
    const account = resolveSocketChatAccount(
      cfg({ "socket-chat": { apiBaseUrl: "https://x.com" } }),
      DEFAULT_ACCOUNT_ID,
    );
    expect(isSocketChatAccountConfigured(account)).toBe(false);
  });

  it("returns true when apiKey is set (apiBaseUrl has default)", () => {
    const account = resolveSocketChatAccount(
      cfg({ "socket-chat": { apiKey: "k" } }),
      DEFAULT_ACCOUNT_ID,
    );
    expect(isSocketChatAccountConfigured(account)).toBe(true);
  });

  it("returns false when both are missing", () => {
    const account = resolveSocketChatAccount({}, DEFAULT_ACCOUNT_ID);
    expect(isSocketChatAccountConfigured(account)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listSocketChatAccountIds
// ---------------------------------------------------------------------------

describe("listSocketChatAccountIds", () => {
  it("returns [default] when top-level apiKey is set", () => {
    const c = cfg({ "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com" } });
    expect(listSocketChatAccountIds(c)).toEqual(["default"]);
  });

  it("returns named account ids when only accounts map is set", () => {
    const c = cfg({
      "socket-chat": {
        accounts: {
          alpha: { apiKey: "k1", apiBaseUrl: "https://a.com" },
          beta: { apiKey: "k2", apiBaseUrl: "https://b.com" },
        },
      },
    });
    const ids = listSocketChatAccountIds(c);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).not.toContain("default");
  });

  it("prepends default when top-level apiKey and named accounts both exist", () => {
    const c = cfg({
      "socket-chat": {
        apiKey: "top-k",
        apiBaseUrl: "https://x.com",
        accounts: { work: { apiKey: "work-k", apiBaseUrl: "https://work.com" } },
      },
    });
    const ids = listSocketChatAccountIds(c);
    expect(ids[0]).toBe("default");
    expect(ids).toContain("work");
  });

  it("returns [] when no socket-chat config at all", () => {
    expect(listSocketChatAccountIds({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultSocketChatAccountId
// ---------------------------------------------------------------------------

describe("resolveDefaultSocketChatAccountId", () => {
  it("returns first account id", () => {
    const c = cfg({
      "socket-chat": {
        accounts: { alpha: { apiKey: "k", apiBaseUrl: "https://a.com" } },
      },
    });
    const id = resolveDefaultSocketChatAccountId(c);
    expect(id).toBe("alpha");
  });

  it("falls back to 'default' on empty config", () => {
    expect(resolveDefaultSocketChatAccountId({})).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// normalizeAccountId
// ---------------------------------------------------------------------------

describe("normalizeAccountId", () => {
  it("trims and lowercases", () => {
    expect(normalizeAccountId("  Work  ")).toBe("work");
  });

  it("returns default for empty string", () => {
    expect(normalizeAccountId("")).toBe("default");
  });

  it("returns default for undefined", () => {
    expect(normalizeAccountId(undefined)).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// setSocketChatAccountEnabled
// ---------------------------------------------------------------------------

describe("setSocketChatAccountEnabled", () => {
  it("sets enabled on top-level (default account)", () => {
    const c: CoreConfig = cfg({ "socket-chat": { apiKey: "k" } });
    const updated = setSocketChatAccountEnabled({ cfg: c, accountId: "default", enabled: false });
    expect(updated.channels?.["socket-chat"]?.enabled).toBe(false);
  });

  it("sets enabled on named account", () => {
    const c: CoreConfig = cfg({
      "socket-chat": {
        accounts: { work: { apiKey: "k", apiBaseUrl: "https://x.com" } },
      },
    });
    const updated = setSocketChatAccountEnabled({ cfg: c, accountId: "work", enabled: false });
    expect(updated.channels?.["socket-chat"]?.accounts?.["work"]?.enabled).toBe(false);
  });

  it("does not mutate original config", () => {
    const c: CoreConfig = cfg({ "socket-chat": { apiKey: "k" } });
    setSocketChatAccountEnabled({ cfg: c, accountId: "default", enabled: false });
    expect(c.channels?.["socket-chat"]?.enabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteSocketChatAccount
// ---------------------------------------------------------------------------

describe("deleteSocketChatAccount", () => {
  it("clears apiKey/apiBaseUrl on default account", () => {
    const c: CoreConfig = cfg({ "socket-chat": { apiKey: "k", apiBaseUrl: "https://x.com" } });
    const updated = deleteSocketChatAccount({ cfg: c, accountId: "default" });
    expect(updated.channels?.["socket-chat"]?.apiKey).toBeUndefined();
    expect(updated.channels?.["socket-chat"]?.apiBaseUrl).toBeUndefined();
  });

  it("removes named account from accounts map", () => {
    const c: CoreConfig = cfg({
      "socket-chat": {
        accounts: {
          work: { apiKey: "k", apiBaseUrl: "https://x.com" },
          home: { apiKey: "k2", apiBaseUrl: "https://y.com" },
        },
      },
    });
    const updated = deleteSocketChatAccount({ cfg: c, accountId: "work" });
    expect(updated.channels?.["socket-chat"]?.accounts?.["work"]).toBeUndefined();
    expect(updated.channels?.["socket-chat"]?.accounts?.["home"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// applySocketChatAccountConfig
// ---------------------------------------------------------------------------

describe("applySocketChatAccountConfig", () => {
  it("writes top-level fields for default account", () => {
    const updated = applySocketChatAccountConfig({
      cfg: {},
      accountId: "default",
      apiKey: "new-key",
      apiBaseUrl: "https://new.com",
      name: "My Bot",
    });
    expect(updated.channels?.["socket-chat"]?.apiKey).toBe("new-key");
    expect(updated.channels?.["socket-chat"]?.apiBaseUrl).toBe("https://new.com");
    expect(updated.channels?.["socket-chat"]?.name).toBe("My Bot");
    expect(updated.channels?.["socket-chat"]?.enabled).toBe(true);
  });

  it("writes to named account in accounts map", () => {
    const updated = applySocketChatAccountConfig({
      cfg: {},
      accountId: "work",
      apiKey: "work-key",
      apiBaseUrl: "https://work.com",
    });
    const workCfg = updated.channels?.["socket-chat"]?.accounts?.["work"];
    expect(workCfg?.apiKey).toBe("work-key");
    expect(workCfg?.apiBaseUrl).toBe("https://work.com");
    expect(workCfg?.enabled).toBe(true);
  });

  it("does not set name when not provided", () => {
    const updated = applySocketChatAccountConfig({
      cfg: {},
      accountId: "default",
      apiKey: "k",
      apiBaseUrl: "https://x.com",
    });
    expect(updated.channels?.["socket-chat"]?.name).toBeUndefined();
  });

  it("merges with existing config (preserves unrelated fields)", () => {
    const c: CoreConfig = cfg({
      "socket-chat": { apiKey: "old", apiBaseUrl: "https://old.com", dmPolicy: "open" },
    });
    const updated = applySocketChatAccountConfig({
      cfg: c,
      accountId: "default",
      apiKey: "new",
      apiBaseUrl: "https://new.com",
    });
    expect(updated.channels?.["socket-chat"]?.dmPolicy).toBe("open");
    expect(updated.channels?.["socket-chat"]?.apiKey).toBe("new");
  });
});
