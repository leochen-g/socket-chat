import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = path.dirname(fileURLToPath(import.meta.url));
const openclawSrc = path.join(dir, "..", "openclaw", "src");

export default defineConfig({
  resolve: {
    alias: [
      // Point directly to the allowlist-match module to avoid pulling in the
      // entire plugin-sdk dependency tree (which includes json5 and other
      // modules that fail to load outside the openclaw workspace).
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(dir, "src", "__sdk-stub__.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
