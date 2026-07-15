// 网易云登录窗口流程（Electron 主进程）。
//
// 安全约束：
// - 独立、非持久化 Session partition，不用 defaultSession 存网易云 Cookie；
// - 每次登录前清空该 partition 的 Cookie 和站点存储，避免账号串用；
// - 登录页不配置 preload、sandbox: true、contextIsolation: true；
// - 顶层导航和新窗口按策略白名单限制；权限请求一律拒绝；
// - 同一时间最多一个登录流程，重复调用复用同一流程；
// - Cookie 只在内存中传递给 IPC 调用方，绝不写日志 / 文件 / Store。

const { BrowserWindow, session } = require("electron");
const {
  NETEASE_LOGIN_URL,
  filterNeteaseCookies,
  hasMusicU,
  isAllowedTopLevelNavigation,
} = require("./netease-login-policy");

// 不带 persist: 前缀 → 内存 Session，应用退出即销毁
const LOGIN_PARTITION = "netease-login";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

let activeLoginPromise = null;
let activeLoginWindow = null;

async function clearLoginPartition(loginSession) {
  await loginSession.clearStorageData();
}

function runNeteaseLogin(parentWindow) {
  return new Promise((resolve) => {
    const loginSession = session.fromPartition(LOGIN_PARTITION);
    // 登录窗口的所有权限请求默认拒绝（麦克风、通知、地理位置等）
    loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    let settled = false;
    let timeoutTimer = null;
    let win = null;

    const cookiesApi = loginSession.cookies;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      cookiesApi.removeListener("changed", onCookieChanged);
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      win = null;
      activeLoginWindow = null;
      // 结束后清空登录 Session，凭据不留在 Electron 内
      clearLoginPartition(loginSession).catch(() => {});
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    async function onCookieChanged(_event, cookie, _cause, removed) {
      if (settled) return;
      if (removed || cookie?.name !== "MUSIC_U" || !cookie?.value) return;
      try {
        const allCookies = await cookiesApi.get({});
        const filtered = filterNeteaseCookies(allCookies);
        if (!hasMusicU(filtered)) return;
        finish({ ok: true, cookies: filtered });
      } catch {
        finish({ ok: false, error: "读取网易云登录状态失败" });
      }
    }

    (async () => {
      try {
        // 开始前清理旧 Cookie / 站点存储，避免上一次账号残留
        await clearLoginPartition(loginSession);
      } catch {
        finish({ ok: false, error: "无法初始化网易云登录窗口" });
        return;
      }
      if (settled) return;

      win = new BrowserWindow({
        parent: parentWindow,
        modal: true,
        show: false,
        width: 1024,
        height: 740,
        autoHideMenuBar: true,
        title: "登录网易云音乐",
        backgroundColor: "#050816",
        webPreferences: {
          partition: LOGIN_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          // 远程登录页不配置任何 preload
        },
      });
      activeLoginWindow = win;

      // 新窗口一律拒绝；顶层导航只允许 HTTPS 的 music.163.com 域内页面
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (!isAllowedTopLevelNavigation(url)) {
          event.preventDefault();
        }
      });

      cookiesApi.on("changed", onCookieChanged);

      timeoutTimer = setTimeout(() => {
        finish({ ok: false, timedOut: true });
      }, LOGIN_TIMEOUT_MS);

      win.on("ready-to-show", () => {
        if (!settled && win && !win.isDestroyed()) win.show();
      });
      // 用户主动关闭（cleanup 中的 destroy 因 settled 标记不会二次触发 finish）
      win.on("closed", () => {
        finish({ ok: false, cancelled: true });
      });

      win.loadURL(NETEASE_LOGIN_URL).catch(() => {
        finish({ ok: false, error: "无法打开网易云登录页" });
      });
    })();
  });
}

/**
 * 启动（或复用进行中的）网易云登录流程。
 * 重复点击 / 并发 IPC 调用共享同一流程和同一结果。
 */
function startNeteaseLogin(parentWindow) {
  if (activeLoginPromise) {
    if (activeLoginWindow && !activeLoginWindow.isDestroyed()) {
      activeLoginWindow.focus();
    }
    return activeLoginPromise;
  }
  activeLoginPromise = runNeteaseLogin(parentWindow).finally(() => {
    activeLoginPromise = null;
  });
  return activeLoginPromise;
}

module.exports = { startNeteaseLogin };
