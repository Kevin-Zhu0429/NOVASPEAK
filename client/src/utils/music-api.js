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
  } catch (error) {
    // 主动取消原样抛出，调用方（组件卸载等）自行忽略
    if (error?.name === "AbortError") throw error;
    throw new Error("网络连接失败，请稍后重试", { cause: error });
  }
  return parseJsonResponse(response, fallbackError);
}

function buildPageQuery({ limit, offset } = {}) {
  const params = new URLSearchParams();
  if (limit !== undefined && limit !== null) params.set("limit", String(limit));
  if (offset !== undefined && offset !== null) {
    params.set("offset", String(offset));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
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

/**
 * 分页获取当前用户的网易云歌单。
 * 返回 { playlists: [...], pagination: { limit, offset, more, total } }。
 */
export async function getNeteasePlaylists(
  apiBase,
  { limit, offset, signal, fetchImpl } = {}
) {
  return requestMusicApi(
    apiBase,
    `/api/music/netease/playlists${buildPageQuery({ limit, offset })}`,
    { method: "GET", signal },
    { fetchImpl, fallbackError: "获取网易云歌单失败" }
  );
}

/**
 * 分页获取指定歌单的歌曲列表。
 * 返回 { playlist, tracks: [...], pagination }。
 */
export async function getNeteasePlaylistTracks(
  apiBase,
  playlistId,
  { limit, offset, signal, fetchImpl } = {}
) {
  if (typeof playlistId !== "string" || !playlistId.trim()) {
    throw new Error("歌单编号无效");
  }
  return requestMusicApi(
    apiBase,
    `/api/music/netease/playlists/${encodeURIComponent(playlistId.trim())}/tracks${buildPageQuery({ limit, offset })}`,
    { method: "GET", signal },
    { fetchImpl, fallbackError: "获取歌单歌曲失败" }
  );
}

/**
 * 按关键词搜索当前已绑定网易云账号可见的歌曲。
 */
export async function searchNeteaseTracks(
  apiBase,
  keywords,
  { limit, offset, signal, fetchImpl } = {}
) {
  if (typeof keywords !== "string" || !keywords.trim()) {
    throw new Error("请输入歌曲或歌手名称");
  }
  const params = new URLSearchParams();
  params.set("keywords", keywords.trim());
  if (limit !== undefined && limit !== null) params.set("limit", String(limit));
  if (offset !== undefined && offset !== null) params.set("offset", String(offset));
  return requestMusicApi(
    apiBase,
    `/api/music/netease/search/tracks?${params.toString()}`,
    { method: "GET", signal },
    { fetchImpl, fallbackError: "搜索网易云歌曲失败" }
  );
}

function requireChannelId(channelId) {
  if (typeof channelId !== "string" || !channelId.trim()) {
    throw new Error("频道无效");
  }
  return encodeURIComponent(channelId.trim());
}

/**
 * 获取当前频道的共享音乐队列（按预计公平播放顺序）。
 */
export async function getChannelMusicQueue(
  apiBase,
  channelId,
  { signal, fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue`,
    { method: "GET", signal },
    { fetchImpl, fallbackError: "获取频道队列失败" }
  );
}

/**
 * 管理员暂停或继续当前频道的音乐播放。
 */
export async function setChannelMusicPaused(
  apiBase,
  channelId,
  paused,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  if (typeof paused !== "boolean") throw new Error("暂停状态无效");
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/playback/pause`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused }),
    },
    { fetchImpl, fallbackError: paused ? "暂停播放失败" : "继续播放失败" }
  );
}

/**
 * 管理员跳过当前歌曲，公平队列继续消费下一首。
 */
export async function skipChannelMusicTrack(
  apiBase,
  channelId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/playback/skip`,
    { method: "POST" },
    { fetchImpl, fallbackError: "切换下一首失败" }
  );
}

/**
 * 随机打乱频道中各用户桶内部的待播歌曲；服务端保留跨用户公平交替。
 */
export async function shuffleChannelMusicQueue(
  apiBase,
  channelId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/shuffle`,
    { method: "POST" },
    { fetchImpl, fallbackError: "随机排序失败" }
  );
}

/**
 * 将某个待播歌曲设置为下一首播放。
 */
export async function prioritizeChannelMusicQueueItem(
  apiBase,
  channelId,
  queueItemId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  if (typeof queueItemId !== "string" || !queueItemId.trim()) {
    throw new Error("队列项无效");
  }
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/${encodeURIComponent(queueItemId.trim())}/prioritize`,
    { method: "POST" },
    { fetchImpl, fallbackError: "设置优先播放失败" }
  );
}

/**
 * 单曲点歌：只提交 playlistId/songId/trackIndex，
 * 歌曲元数据由服务端从网易云取回，不提交任何展示数据。
 */
export async function enqueueNeteaseTrack(
  apiBase,
  channelId,
  { playlistId, songId, trackIndex },
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/tracks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId, songId, trackIndex }),
    },
    { fetchImpl, fallbackError: "点歌失败" }
  );
}

/**
 * 从搜索结果点歌。前端只提交歌曲 ID，服务端重新查询并验证元数据和权限。
 */
export async function enqueueNeteaseSearchTrack(
  apiBase,
  channelId,
  { songId },
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/search-tracks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId }),
    },
    { fetchImpl, fallbackError: "点歌失败" }
  );
}

/**
 * 把整个歌单添加到频道队列（服务端只加入可播放歌曲）。
 */
export async function enqueueNeteasePlaylist(
  apiBase,
  channelId,
  { playlistId },
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/playlists`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlistId }),
    },
    { fetchImpl, fallbackError: "添加歌单失败" }
  );
}

/**
 * 取消一个待播放队列项（本人或管理员）。
 */
export async function cancelMusicQueueItem(
  apiBase,
  channelId,
  queueItemId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  if (typeof queueItemId !== "string" || !queueItemId.trim()) {
    throw new Error("队列项无效");
  }
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/${encodeURIComponent(queueItemId.trim())}`,
    { method: "DELETE" },
    { fetchImpl, fallbackError: "取消歌曲失败" }
  );
}

/** 删除当前用户在频道内的全部待播放歌曲。 */
export async function cancelOwnPendingMusicQueue(
  apiBase,
  channelId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue/mine`,
    { method: "DELETE" },
    { fetchImpl, fallbackError: "删除自己的排队歌曲失败" }
  );
}

/** 管理员清空频道内全部待播放歌曲。 */
export async function clearChannelMusicQueue(
  apiBase,
  channelId,
  { fetchImpl } = {}
) {
  const encoded = requireChannelId(channelId);
  return requestMusicApi(
    apiBase,
    `/api/music/netease/channels/${encoded}/queue`,
    { method: "DELETE" },
    { fetchImpl, fallbackError: "清空频道队列失败" }
  );
}
