import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { socketChatPlugin } from "./src/channel.js";
import { setSocketChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "shellbot-chat",
  name: "Shellbot Chat",
  description: "Shellbot Chat channel plugin — MQTT-based IM bridge",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setSocketChatRuntime(api.runtime);
    api.registerChannel({ plugin: socketChatPlugin });
  },
};

export default plugin;
