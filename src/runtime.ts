import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const {
  setRuntime: setSocketChatRuntime,
  getRuntime: getSocketChatRuntime,
  clearRuntime: clearSocketChatRuntime,
} = createPluginRuntimeStore<PluginRuntime>("socket-chat runtime not initialized");

export { setSocketChatRuntime, getSocketChatRuntime, clearSocketChatRuntime };
