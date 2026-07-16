const { contextBridge, ipcRenderer } = require("electron");

// 只暴露最小只读桌面信息 + 网易云登录桥接。
// 禁止暴露:fs、child_process、shell、ipcRenderer 本体、
// 环境变量、LiveKit / session 等任何 secret。
contextBridge.exposeInMainWorld("novaDesktop", {
  platform: process.platform,
  isDesktop: true,
  // 打开网易云官方登录窗口；成功返回 { ok: true, cookies: [{ name, value }] }，
  // 用户关闭返回 { ok: false, cancelled: true }。Cookie 只在内存中传递。
  loginNetease: () => ipcRenderer.invoke("nova:netease-login"),
});
