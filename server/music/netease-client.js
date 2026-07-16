// NeteaseCloudMusicApi 的唯一封装入口：其他业务文件不得直接 require 该依赖。
// 所有请求都必须携带当前用户自己的 Cookie，绝不使用全局共享凭据。
// 第三方异常在这里统一转换为项目内部稳定错误码；
// 不得打印 Cookie、MUSIC_U、请求头或网易云完整响应。

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const NETEASE_ERROR = Object.freeze({
  SESSION_INVALID: "NETEASE_SESSION_INVALID",
  REQUEST_FAILED: "NETEASE_REQUEST_FAILED",
  RATE_LIMITED: "NETEASE_RATE_LIMITED",
});

export const NETEASE_PLAYBACK_ERROR = Object.freeze({
  SESSION_INVALID: "NETEASE_PLAYBACK_SESSION_INVALID",
  URL_UNAVAILABLE: "NETEASE_PLAYBACK_URL_UNAVAILABLE",
  TRIAL_ONLY: "NETEASE_PLAYBACK_TRIAL_ONLY",
  RATE_LIMITED: "NETEASE_PLAYBACK_RATE_LIMITED",
  RESPONSE_INVALID: "NETEASE_PLAYBACK_RESPONSE_INVALID",
  REQUEST_FAILED: "NETEASE_PLAYBACK_REQUEST_FAILED",
});

const DEFAULT_TIMEOUT_MS = 10_000;

export class NeteaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NeteaseError";
    this.code = code;
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new NeteaseError(
          NETEASE_ERROR.REQUEST_FAILED,
          "网易云服务响应超时，请稍后再试"
        )
      );
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// 只提取错误的 HTTP 状态与业务 code，绝不透出第三方响应内容
function toNeteaseError(error) {
  if (error instanceof NeteaseError) return error;

  const status = Number(error?.status ?? error?.body?.code ?? 0);

  if (status === 429) {
    return new NeteaseError(
      NETEASE_ERROR.RATE_LIMITED,
      "网易云请求过于频繁，请稍后再试"
    );
  }

  if (status === 301 || status === 302 || status === 401) {
    return new NeteaseError(
      NETEASE_ERROR.SESSION_INVALID,
      "网易云登录已失效，请重新扫码登录"
    );
  }

  return new NeteaseError(
    NETEASE_ERROR.REQUEST_FAILED,
    "网易云服务暂时不可用，请稍后再试"
  );
}

function normalizeProfile(data) {
  const profile = data?.profile;
  const account = data?.account;

  if (!profile || typeof profile !== "object") return null;

  const neteaseUserId = profile.userId ?? account?.id ?? null;
  if (neteaseUserId === null || neteaseUserId === undefined) return null;

  return {
    neteaseUserId: String(neteaseUserId),
    nickname:
      typeof profile.nickname === "string" && profile.nickname.trim()
        ? profile.nickname.trim()
        : null,
    avatarUrl:
      typeof profile.avatarUrl === "string" &&
      /^https?:\/\//.test(profile.avatarUrl)
        ? profile.avatarUrl
        : null,
  };
}

/**
 * 创建网易云客户端。api 参数仅供测试注入 mock，
 * 生产环境默认加载 NeteaseCloudMusicApi（CommonJS，经 createRequire 引入）。
 */
export function createNeteaseClient({
  api = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let apiModule = api;

  function getApi() {
    if (!apiModule) {
      apiModule = require("NeteaseCloudMusicApi");
    }
    return apiModule;
  }

  function requireCookie(cookieHeader) {
    if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
      throw new NeteaseError(
        NETEASE_ERROR.SESSION_INVALID,
        "网易云登录信息无效，请重新登录"
      );
    }
  }

  // 上游 reject（{status, body} 结构）→ 播放专用稳定错误
  function mapPlaybackUpstreamError(error) {
    if (error instanceof NeteaseError) {
      // withTimeout 等内部错误按请求失败处理
      return new NeteaseError(
        NETEASE_PLAYBACK_ERROR.REQUEST_FAILED,
        "获取播放地址失败，请稍后再试"
      );
    }
    const status = Number(error?.status ?? error?.body?.code ?? 0);
    if (status === 429) {
      return new NeteaseError(
        NETEASE_PLAYBACK_ERROR.RATE_LIMITED,
        "网易云请求过于频繁，请稍后再试"
      );
    }
    if (status === 301 || status === 302 || status === 401) {
      return new NeteaseError(
        NETEASE_PLAYBACK_ERROR.SESSION_INVALID,
        "网易云登录已失效，请重新登录"
      );
    }
    return new NeteaseError(
      NETEASE_PLAYBACK_ERROR.REQUEST_FAILED,
      "获取播放地址失败，请稍后再试"
    );
  }

  // 上游 reject 是否是带 HTTP 语义的明确拒绝（而非库兼容性异常）
  function isUpstreamRejection(error) {
    return (
      Number.isFinite(Number(error?.status)) && Number(error?.status) > 0
    ) || Number.isFinite(Number(error?.body?.code));
  }

  // 提取单曲播放条目并做完整校验；结构无效抛 RESPONSE_INVALID
  function extractPlaybackEntry(response, songId) {
    const body = response?.body;
    if (!body || body.code !== 200 || !Array.isArray(body.data)) {
      throw new NeteaseError(
        NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID,
        "网易云返回了无效的播放数据"
      );
    }
    const entry = body.data.find(
      (item) => item && String(item.id) === songId
    );
    if (!entry || typeof entry !== "object") {
      throw new NeteaseError(
        NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID,
        "网易云返回了无效的播放数据"
      );
    }
    return entry;
  }

  async function callApi(method, params) {
    try {
      return await withTimeout(getApi()[method](params), timeoutMs);
    } catch (error) {
      throw toNeteaseError(error);
    }
  }

  return {
    /**
     * 分页读取指定网易云账号的歌单（自建 + 收藏）。
     * 必须使用当前用户自己的 Cookie 和数据库中记录的 netease_user_id。
     * 返回第三方原始歌单数组 + more 标记，由上层标准化。
     */
    async listUserPlaylists({ neteaseUserId, cookie, limit = 30, offset = 0 }) {
      requireCookie(cookie);
      if (typeof neteaseUserId !== "string" || !/^\d+$/.test(neteaseUserId)) {
        throw new NeteaseError(
          NETEASE_ERROR.SESSION_INVALID,
          "网易云账号信息无效，请重新登录"
        );
      }

      const response = await callApi("user_playlist", {
        uid: neteaseUserId,
        limit,
        offset,
        cookie,
      });

      const body = response?.body;
      if (!body || body.code !== 200 || !Array.isArray(body.playlist)) {
        throw new NeteaseError(
          NETEASE_ERROR.REQUEST_FAILED,
          "网易云返回了无效的歌单数据"
        );
      }

      return { playlists: body.playlist, more: body.more === true };
    },

    /**
     * 分页读取歌单内歌曲。playlist_track_all 内部先取歌单 trackIds
     * 再查 song_detail，最终 body 为 { code, songs, privileges }。
     */
    async listPlaylistTracks({ playlistId, cookie, limit = 50, offset = 0 }) {
      requireCookie(cookie);
      if (typeof playlistId !== "string" || !/^\d+$/.test(playlistId)) {
        throw new NeteaseError(
          NETEASE_ERROR.REQUEST_FAILED,
          "歌单编号无效"
        );
      }

      const response = await callApi("playlist_track_all", {
        id: playlistId,
        limit,
        offset,
        cookie,
      });

      const body = response?.body;
      if (!body || body.code !== 200 || !Array.isArray(body.songs)) {
        throw new NeteaseError(
          NETEASE_ERROR.REQUEST_FAILED,
          "网易云返回了无效的歌曲数据"
        );
      }

      return {
        songs: body.songs,
        privileges: Array.isArray(body.privileges) ? body.privileges : [],
      };
    },

    /**
     * 获取单曲完整播放地址（点歌者自己的 Cookie）。
     *
     * 优先 song_url_v1(level: standard)；只有在 v1 方法不存在、
     * 发生库兼容性异常或响应结构明显无效时才降级 song_url(br: 128000)。
     * 明确的无版权 / 无权限 / 试听限制 / 登录失效 / 限流一律直接抛出，
     * 绝不用旧接口绕过。
     *
     * URL 只在调用方的播放函数作用域中短暂存在：
     * 不写数据库、不返回前端、不写日志。
     */
    async getSongPlaybackUrl({ songId, cookie }) {
      requireCookie(cookie);
      if (typeof songId !== "string" || !/^\d{1,20}$/.test(songId)) {
        throw new NeteaseError(
          NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID,
          "歌曲编号无效"
        );
      }

      const api = getApi();
      let entry = null;
      let shouldFallback = typeof api.song_url_v1 !== "function";

      if (!shouldFallback) {
        try {
          const response = await withTimeout(
            api.song_url_v1({ id: songId, level: "standard", cookie }),
            timeoutMs
          );
          entry = extractPlaybackEntry(response, songId);
        } catch (error) {
          if (
            error instanceof NeteaseError &&
            error.code === NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID
          ) {
            // v1 响应结构明显无效 → 允许降级旧接口
            shouldFallback = true;
          } else if (!isUpstreamRejection(error) && !(error instanceof NeteaseError)) {
            // 库自身兼容性异常（非 HTTP 语义拒绝）→ 允许降级
            shouldFallback = true;
          } else {
            throw mapPlaybackUpstreamError(error);
          }
        }
      }

      if (shouldFallback) {
        try {
          const response = await withTimeout(
            api.song_url({ id: songId, br: 128000, cookie }),
            timeoutMs
          );
          entry = extractPlaybackEntry(response, songId);
        } catch (error) {
          if (
            error instanceof NeteaseError &&
            error.code === NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID
          ) {
            throw error;
          }
          throw mapPlaybackUpstreamError(error);
        }
      }

      // 单曲级校验：试听、无权限、URL 为空都拒绝，不尝试其他音质
      if (entry.freeTrialInfo) {
        throw new NeteaseError(
          NETEASE_PLAYBACK_ERROR.TRIAL_ONLY,
          "该歌曲只有试听片段，无法完整播放"
        );
      }
      const entryCode = Number(entry.code ?? 0);
      if (entryCode !== 200) {
        throw new NeteaseError(
          NETEASE_PLAYBACK_ERROR.URL_UNAVAILABLE,
          "当前账号无法播放该歌曲"
        );
      }
      if (typeof entry.url !== "string" || !entry.url) {
        throw new NeteaseError(
          NETEASE_PLAYBACK_ERROR.URL_UNAVAILABLE,
          "该歌曲暂无可用播放地址"
        );
      }

      return { url: entry.url };
    },

    /**
     * 校验网易云登录状态并返回账号资料。
     * cookieHeader 必须是当前用户自己的标准 Cookie 请求头字符串。
     *
     * @returns {Promise<{ neteaseUserId: string, nickname: string | null,
     *   avatarUrl: string | null }>}
     * @throws {NeteaseError}
     */
    async verifySession(cookieHeader) {
      if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
        throw new NeteaseError(
          NETEASE_ERROR.SESSION_INVALID,
          "网易云登录信息无效，请重新扫码登录"
        );
      }

      let response;
      try {
        response = await withTimeout(
          getApi().login_status({ cookie: cookieHeader }),
          timeoutMs
        );
      } catch (error) {
        throw toNeteaseError(error);
      }

      // login_status 成功时返回 { status: 200, body: { data: { code, account, profile } } }
      const data = response?.body?.data ?? response?.body ?? null;
      const profile = normalizeProfile(data);

      if (!profile) {
        throw new NeteaseError(
          NETEASE_ERROR.SESSION_INVALID,
          "网易云登录已失效，请重新扫码登录"
        );
      }

      return profile;
    },
  };
}
