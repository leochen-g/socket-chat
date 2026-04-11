import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "socket-chat",
  name: "Socket Chat",
  description: "Socket Chat channel plugin — MQTT-based IM bridge",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-api.js",
    exportName: "socketChatPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setSocketChatRuntime",
  },
});
