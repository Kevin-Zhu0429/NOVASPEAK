const { contextBridge } = require("electron");

// 5A 阶段只暴露最小只读桌面信息。
// 禁止暴露:fs、child_process、shell、环境变量、LiveKit / session 等任何 secret。
contextBridge.exposeInMainWorld("novaDesktop", {
  platform: process.platform,
  isDesktop: true,
});
