const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const {
  PROD_APP_URL,
  classifyMainWindowNavigation,
} = require("./main-window-policy");
const { startNeteaseLogin } = require("./netease-login");
const { startAutoUpdates } = require("./auto-update");

const DEV_SERVER_URL = "http://localhost:5173";

// NOVASPEAK_DESKTOP_DEV=true 强制开发模式;=false 强制加载线上生产应用;
// 未设置时,未打包运行(electron .)默认视为开发模式。
const desktopDevFlag = process.env.NOVASPEAK_DESKTOP_DEV;
const isDev =
  desktopDevFlag === "true" || (!app.isPackaged && desktopDevFlag !== "false");

// 渲染进程权限白名单:保证 getUserMedia 麦克风流程可用,其余一律拒绝。
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "mediaKeySystem",
  "speaker-selection",
  "fullscreen",
  "notifications",
  "clipboard-sanitized-write",
]);

function buildDevServerErrorPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>NovaSpeak</title></head>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#050816;color:#e2f5f5;font-family:system-ui,sans-serif;">
    <div style="max-width:32rem;text-align:center;line-height:1.8;">
      <h1 style="color:#22d3ee;font-size:1.25rem;">无法连接 NovaSpeak 前端开发服务器</h1>
      <p>请先在 client 目录运行 <code style="color:#22d3ee;">npm run dev</code>,<br />确认 ${DEV_SERVER_URL} 可访问后,<a href="${DEV_SERVER_URL}" style="color:#22d3ee;">点此重试</a>。</p>
    </div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// NovaSpeak 主窗口引用：IPC 调用来源校验与登录窗口父窗口都依赖它
let mainWindow = null;
let autoUpdateController = null;

function createMainWindow() {
  const win = new BrowserWindow({
    title: "NovaSpeak",
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#050816",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // 新窗口一律拒绝,外部链接交给系统默认浏览器打开。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const mainPageUrl = isDev ? DEV_SERVER_URL : PROD_APP_URL;
  win.webContents.on("will-navigate", (event, url) => {
    const action = classifyMainWindowNavigation(url, mainPageUrl);
    if (action === "allow") return;
    event.preventDefault();
    if (action === "external") shell.openExternal(url);
  });

  if (isDev) {
    win.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL && validatedURL.startsWith(DEV_SERVER_URL)) {
        console.error(`[NovaSpeak] 加载 ${validatedURL} 失败:${errorDescription} (${errorCode})`);
        win.loadURL(buildDevServerErrorPage());
      }
    });
    win.loadURL(DEV_SERVER_URL);
  } else {
    // 打包版直接加载同源线上应用，/api、/ws、/uploads 与 Session Cookie
    // 全部继续由 voice.novagaming.top 提供；桌面包中不保存任何后端密钥。
    win.loadURL(PROD_APP_URL);
  }

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  // 网易云登录：唯一、明确的 IPC handler。
  // 只接受 NovaSpeak 主窗口发起的调用，登录窗口或其他来源一律拒绝。
  ipcMain.handle("nova:netease-login", (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, error: "未授权的调用来源" };
    }
    return startNeteaseLogin(mainWindow);
  });

  createMainWindow();
  autoUpdateController = startAutoUpdates({
    app,
    dialog,
    getMainWindow: () => mainWindow,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  autoUpdateController?.stop();
  autoUpdateController = null;
});
