import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));
const openclawSrc = path.join(dir, "..", "openclaw", "src");
const sdkSrc = path.join(openclawSrc, "plugin-sdk");

export default defineConfig({
  resolve: {
    alias: [
      // Per-subpath aliases must come BEFORE the broad "openclaw/plugin-sdk" fallback.
      { find: "openclaw/plugin-sdk/runtime-store",          replacement: path.join(sdkSrc, "runtime-store.ts") },
      { find: "openclaw/plugin-sdk/channel-pairing",        replacement: path.join(sdkSrc, "channel-pairing.ts") },
      { find: "openclaw/plugin-sdk/channel-lifecycle",      replacement: path.join(sdkSrc, "channel-lifecycle.ts") },
      { find: "openclaw/plugin-sdk/inbound-reply-dispatch", replacement: path.join(sdkSrc, "inbound-reply-dispatch.ts") },
      { find: "openclaw/plugin-sdk/reply-payload",          replacement: path.join(sdkSrc, "reply-payload.ts") },
      { find: "openclaw/plugin-sdk/media-runtime",          replacement: path.join(sdkSrc, "media-runtime.ts") },
      { find: "openclaw/plugin-sdk/allow-from",             replacement: path.join(sdkSrc, "allow-from.ts") },
      { find: "openclaw/plugin-sdk/status-helpers",         replacement: path.join(sdkSrc, "status-helpers.ts") },
      { find: "openclaw/plugin-sdk/channel-core",           replacement: path.join(sdkSrc, "channel-core.ts") },
      // Broad fallback for any remaining "openclaw/plugin-sdk" (main barrel) imports.
      { find: "openclaw/plugin-sdk",                        replacement: path.join(dir, "src", "__sdk-stub__.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
