// 网易云音乐账号绑定 API 工具。
// 身份只由后端 req.authUser（NovaSpeak Session Cookie）决定，
// 绝不提交前端 userId；绝不记录 cookies，也不把 cookies 放进错误对象。

async function parseJsonResponse(response, fallbackError) {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(fallbackError);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(fallbackError);
  }
  if (!response.ok) {
    const message =
      typeof data?.error === "string" && data.error.trim()
        ? data.error.trim()
        : fallbackError;
    const error = new Error(message);
    if (typeof data?.code === "string") error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

async function requestMusicApi(
  apiBase,
  path,
  options,
  { fetchImpl, fallbackError }
) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let response;
  try {
    response = await doFetch(`${apiBase}${path}`, {
      credentials: "include",
      ...options,
    });
  } catch {
    throw new Error("网络连接失败，请稍后重试");
  }
  return parseJsonResponse(response, fallbackError);
}

/**
 * 查询当前用户的网易云绑定状态。
 * 返回 { bound: boolean, account?: { neteaseUserId, nickname, avatarUrl } }。
 */
export async function getNeteaseAccount(apiBase, { fetchImpl } = {}) {
  return requestMusicApi(
    apiBase,
    "/api/music/netease/account",
    { method: "GET" },
    { fetchImpl, fallbackError: "查询网易云绑定状态失败" }
  );
}

/**
 * 用 Electron 登录窗口取得的 Cookie 绑定网易云账号。
 * cookies 只作为请求体一次性提交，本函数不保留任何引用、不写入存储。
 */
export async function bindNeteaseSession(apiBase, cookies, { fetchImpl } = {}) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("网易云登录信息无效，请重新登录");
  }
  return requestMusicApi(
    apiBase,
    "/api/music/netease/session",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies }),
    },
    { fetchImpl, fallbackError: "绑定网易云账号失败" }
  );
}

/**
 * 解绑当前用户自己的网易云账号。
 */
export async function unbindNeteaseSession(apiBase, { fetchImpl } = {}) {
  return requestMusicApi(
    apiBase,
    "/api/music/netease/session",
    { method: "DELETE" },
    { fetchImpl, fallbackError: "退出网易云账号失败" }
  );
}
