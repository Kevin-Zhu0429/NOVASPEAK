// 网易云登录窗口的纯策略函数：域名校验、Cookie 白名单过滤。
// 不依赖 BrowserWindow / session，可直接用 node:test 单元测试。
// 本模块绝不打印 Cookie 内容。

// 登录地址集中定义，后续调整只改这里
const NETEASE_LOGIN_URL = "https://music.163.com/#/login";

// 顶层导航只允许 music.163.com 本身及其合法子域
const NETEASE_NAVIGATION_ROOT = "music.163.com";

// Cookie 允许挂在网易系根域（例如 NMTID 常见 domain 为 .163.com，
// MUSIC_U 为 .music.163.com）
const NETEASE_COOKIE_ROOT = "163.com";

// 返回给渲染进程的 Cookie 白名单（最小必要集合）
const NETEASE_COOKIE_WHITELIST = Object.freeze([
  "MUSIC_U",
  "__csrf",
  "NMTID",
  "MUSIC_A",
  "os",
  "appver",
  "channel",
]);

function isHostWithinRoot(hostname, root) {
  if (typeof hostname !== "string" || !hostname) return false;
  // 统一小写并去掉尾部点，防止 "MUSIC.163.COM." 绕过
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  // 必须完全相等，或以 ".root" 结尾——"evil-music.163.com" 这类
  // 后缀欺骗不满足 ".music.163.com" 结尾要求
  return host === root || host.endsWith(`.${root}`);
}

/**
 * 登录窗口顶层导航是否允许：必须是 HTTPS 且在 music.163.com 域内。
 */
function isAllowedTopLevelNavigation(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return isHostWithinRoot(parsed.hostname, NETEASE_NAVIGATION_ROOT);
}

/**
 * Cookie domain 是否属于网易系（163.com 及其子域）。
 * 正确处理 Cookie domain 的前导点（".music.163.com"）。
 */
function isNeteaseCookieDomain(domain) {
  if (typeof domain !== "string" || !domain) return false;
  const normalized = domain.toLowerCase().replace(/^\.+/, "");
  return isHostWithinRoot(normalized, NETEASE_COOKIE_ROOT);
}

/**
 * 过滤登录 Session 中的全部 Cookie：
 * - 只保留白名单内的 Cookie 名；
 * - 只保留网易系 domain；
 * - 丢弃空值；
 * - 同名 Cookie 保留最后一次出现的值（确定性规则）；
 * - 输出只含 { name, value }，不带 domain / path / expirationDate。
 */
function filterNeteaseCookies(cookies) {
  const kept = new Map();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!cookie || typeof cookie !== "object") continue;
    const { name, value, domain } = cookie;
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (!NETEASE_COOKIE_WHITELIST.includes(name)) continue;
    if (!isNeteaseCookieDomain(domain)) continue;
    if (!value) continue;
    kept.set(name, value);
  }
  return Array.from(kept, ([name, value]) => ({ name, value }));
}

/**
 * 登录成功的最低要求：过滤结果中存在非空 MUSIC_U。
 */
function hasMusicU(cookies) {
  return (
    Array.isArray(cookies) &&
    cookies.some(
      (cookie) =>
        cookie &&
        cookie.name === "MUSIC_U" &&
        typeof cookie.value === "string" &&
        cookie.value.length > 0
    )
  );
}

module.exports = {
  NETEASE_LOGIN_URL,
  NETEASE_COOKIE_WHITELIST,
  filterNeteaseCookies,
  hasMusicU,
  isAllowedTopLevelNavigation,
  isNeteaseCookieDomain,
};
