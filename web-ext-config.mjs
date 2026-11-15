// Keeps local tooling out of the packaged extension (web-ext build / sign / run).
export default {
  ignoreFiles: [
    "platform-tools-latest-windows",
    "platform-tools-latest-windows/**",
    "platform-tools-latest-windows.zip",
    "web-ext-config.mjs",
    ".claude",
    ".claude/**",
  ],
};
