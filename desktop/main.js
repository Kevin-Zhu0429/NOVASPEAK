const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session, shell } = require("electron");

const DEV_SERVER_URL = "http://localhost:5173";
// 打包 / 生产模式加载 build-renderer.js 复制进来的本地静态包；
// 兼容旧的未打包生产测试路径 ../client/dist。
const RENDERER_INDEX_PATH = path.join(__dirname, "renderer", "index.html");
const LEGACY_DIST_INDEX_PATH = path.join(__dirname, "..", "client", "dist", "index.html");
const APP_CONFIG_PATH = path.join(__dirname, "app-config.json");

// NOVASPEAK_DESKTOP_DEV=true 强制开发模式;=false 强制加载 client/dist;
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

/**
 * 读取打包配置里的后端地址（与渲染层 VITE_API_BASE 同源，
 * 唯一切换点是 desktop/app-config.json 的 backendOrigin）。
 */
function loadBackendOrigin() {
  try {
    const parsed = JSON.parse(fs.readFileSync(APP_CONFIG_PATH, "utf8"));
    const url = new URL(String(parsed?.backendOrigin || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 桌面壳会话桥：本地静态包以 file:// 加载，对线上后端属于跨站请求，
 * 而后端 cors() 默认头与 credentials 模式互斥、会话 Cookie 是 SameSite=Lax，
 * 浏览器规则下无法登录。这里只对配置的后端源做两件事（不改服务器、不放宽其他站点）：
 * 1. 响应头补 Access-Control-Allow-Origin: null + Allow-Credentials: true，
 *    让 file:// 渲染层的携带凭证请求通过 CORS 校验；
 * 2. 把该源的 Set-Cookie 重写为 SameSite=None; Secure，
 *    使会话 Cookie 能在桌面壳内跨站发送（包括 /ws/presence 握手）。
 * 仅影响本应用自身的会话存储，不暴露任何能力给渲染进程。
 */
function rewriteSetCookieForDesktop(cookieValue) {
  const parts = String(cookieValue)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const lower = part.toLowerCase();
      return part && !lower.startsWith("samesite") && lower !== "secure";
    });
  parts.push("SameSite=None", "Secure");
  return parts.join("; ");
}

function installBackendSessionBridge(targetSession, backendOrigin) {
  const filter = { urls: [`${backendOrigin}/*`] };
  targetSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = { ...(details.responseHeaders || {}) };
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (lower === "access-control-allow-origin" || lower === "access-control-allow-credentials") {
        delete responseHeaders[key];
      } else if (lower === "set-cookie") {
        responseHeaders[key] = responseHeaders[key].map(rewriteSetCookieForDesktop);
      }
    }
    responseHeaders["Access-Control-Allow-Origin"] = ["null"];
    responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
    callback({ responseHeaders });
  });
}

function buildProdRendererErrorPage() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>NovaSpeak</title></head>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#050816;color:#e2f5f5;font-family:system-ui,sans-serif;">
    <div style="max-width:32rem;text-align:center;line-height:1.8;">
      <h1 style="color:#22d3ee;font-size:1.25rem;">找不到本地前端静态包</h1>
      <p>请先在 desktop 目录运行 <code style="color:#22d3ee;">npm run build:renderer</code> 生成 renderer/ 后重试。</p>
    </div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

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

  // 同窗口导航同样只允许本地页面（file:// 静态包 / 开发服务器），
  // 其他一律交给系统浏览器：窗口内绝不承载外部站点。
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith("file://") || (isDev && url.startsWith(DEV_SERVER_URL));
    if (allowed) return;
    event.preventDefault();
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
  });

  if (isDev) {
    win.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
      if (validatedURL && validatedURL.startsWith(DEV_SERVER_URL)) {
        console.error(`[NovaSpeak] 加载 ${validatedURL} 失败:${errorDescription} (${errorCode})`);
        win.loadURL(buildDevServerErrorPage());
      }
    });
    win.loadURL(DEV_SERVER_URL);
  } else if (fs.existsSync(RENDERER_INDEX_PATH)) {
    // 生产模式：加载打进安装包的本地静态资源，/api、/ws、/uploads 由渲染层
    // 按构建期注入的 VITE_API_BASE 直连线上后端（见 scripts/build-renderer.js）。
    win.loadFile(RENDERER_INDEX_PATH);
  } else if (fs.existsSync(LEGACY_DIST_INDEX_PATH)) {
    win.loadFile(LEGACY_DIST_INDEX_PATH);
  } else {
    win.loadURL(buildProdRendererErrorPage());
  }

  return win;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  if (!isDev) {
    const backendOrigin = loadBackendOrigin();
    if (backendOrigin) {
      installBackendSessionBridge(session.defaultSession, backendOrigin);
    } else {
      console.error("[NovaSpeak] app-config.json 缺少合法 backendOrigin，生产模式将无法登录后端。");
    }
  }

  createMainWindow();

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
