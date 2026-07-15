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
