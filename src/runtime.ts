import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSocketChatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getSocketChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("shellbot-chat runtime not initialized");
  }
  return runtime;
}
