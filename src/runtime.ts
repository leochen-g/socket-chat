import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setSocketChatRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getSocketChatRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("socket-chat runtime not initialized");
  }
  return runtime;
}
