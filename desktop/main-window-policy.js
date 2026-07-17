const PROD_APP_URL = "https://app.novagaming.top";

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

// 主窗口只允许留在最初加载的站点。这样 preload 暴露的网易云登录桥接
// 不会跟随顶层导航进入第三方页面；普通外链仍交给系统浏览器。
function classifyMainWindowNavigation(rawUrl, allowedPageUrl) {
  const target = parseHttpUrl(rawUrl);
  const allowed = parseHttpUrl(allowedPageUrl);
  if (!target || !allowed) return "deny";
  if (target.origin === allowed.origin) return "allow";
  return "external";
}

module.exports = {
  PROD_APP_URL,
  classifyMainWindowNavigation,
};
