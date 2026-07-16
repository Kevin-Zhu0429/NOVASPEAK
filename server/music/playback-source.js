// 歌曲媒体流打开与安全校验（Stage 5B v2 全新实现）。
//
// 安全规则：
// - 只允许 http/https + 网易云官方媒体域（music.126.net / music.163.com 及严格子域）；
// - 拒绝 IP、localhost、file:/data:/ftp:/javascript:、URL 用户名密码、后缀欺骗；
// - redirect: "manual"，最多 5 跳，每跳 Location 重新验证，重定向 body 立即释放；
// - URL 不写日志（失败时只允许记录 hostname）。
//
// 超时模型（严格区分，绝不用一个总时长超时切断整首歌）：
// - headerTimeout：只等待响应头；Response 返回后立即清除，不再作用于 body；
// - stall timeout：body 每收到一个 chunk 重新计时，长时间无数据才算失败；
// - 外部 AbortSignal：作用于从请求到 body 结束的完整生命周期。
//
// 背压：Readable.fromWeb + 标准 Transform（byte limit），
// 不缓存完整歌曲、不写临时文件、不自定义 push/drain。

import { Readable, Transform } from "node:stream";

export const MEDIA_ERROR = Object.freeze({
  URL_REJECTED: "MEDIA_URL_REJECTED",
  HEADER_TIMEOUT: "MEDIA_HEADER_TIMEOUT",
  STALL_TIMEOUT: "MEDIA_STALL_TIMEOUT",
  FETCH_FAILED: "MEDIA_FETCH_FAILED",
  ABORTED: "MEDIA_ABORTED",
  TOO_LARGE: "MEDIA_TOO_LARGE",
});

export class MediaSourceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "MediaSourceError";
    this.code = code;
  }
}

export const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const DEFAULT_HEADER_TIMEOUT_MS = 15_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

// 初始允许的网易云官方媒体根域；真实歌曲出现其他域名时：
// 只记录 hostname → 人工确认属于网易云官方媒体服务 → 集中加到这里并补测试
const ALLOWED_MEDIA_ROOTS = Object.freeze(["music.126.net", "music.163.com"]);

/**
 * 校验媒体 URL 是否允许访问。
 */
export function isAllowedMediaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  // IPv4 / IPv6 字面量与 localhost 一律拒绝
  if (/^\d+(\.\d+){3}$/.test(host)) return false;
  if (host.includes(":") || host.startsWith("[")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  return ALLOWED_MEDIA_ROOTS.some(
    (root) => host === root || host.endsWith(`.${root}`)
  );
}

/**
 * 提取 hostname 供安全日志使用（绝不返回完整 URL）。
 */
export function mediaUrlHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

/**
 * 字节上限 + stall 超时 Transform：
 * - 标准 Transform 自然处理背压（下游停止时上游暂停）；
 * - 每个 chunk 重置 stall 计时；
 * - 超过 maxBytes 以 MEDIA_TOO_LARGE 销毁整条 pipeline。
 */
export function createByteLimitTransform({
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
} = {}) {
  let totalBytes = 0;
  let stallTimer = null;

  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        clearStall();
        callback(
          new MediaSourceError(MEDIA_ERROR.TOO_LARGE, "歌曲文件过大")
        );
        return;
      }
      resetStall();
      callback(null, chunk);
    },
    flush(callback) {
      clearStall();
      callback();
    },
  });

  function resetStall() {
    clearStall();
    if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) return;
    stallTimer = setTimeout(() => {
      transform.destroy(
        new MediaSourceError(MEDIA_ERROR.STALL_TIMEOUT, "歌曲数据长时间无响应")
      );
    }, stallTimeoutMs);
    stallTimer.unref?.();
  }

  resetStall();
  transform.once("close", clearStall);
  transform.once("error", clearStall);
  return transform;
}

async function fetchHeaders(url, { signal, fetchImpl, headerTimeoutMs }) {
  const headerController = new AbortController();
  const onOuterAbort = () => headerController.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    headerController.abort();
  }, headerTimeoutMs);
  timer.unref?.();

  try {
    // headerController 只作用于「等待响应头」阶段；
    // Response 返回后 finally 清除 timer，body 的生命周期由
    // Readable.fromWeb(…, { signal: 外部 signal }) 管理
    return await fetchImpl(url, {
      redirect: "manual",
      signal: headerController.signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new MediaSourceError(MEDIA_ERROR.ABORTED, "播放已中止");
    }
    if (timedOut) {
      throw new MediaSourceError(
        MEDIA_ERROR.HEADER_TIMEOUT,
        "连接媒体服务器超时"
      );
    }
    throw new MediaSourceError(
      MEDIA_ERROR.FETCH_FAILED,
      "获取歌曲数据失败",
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 打开歌曲媒体流。
 * 返回 Node Readable（未接 byte-limit；由调用方 pipeline 组合），
 * 外部 signal 中止时自动销毁流。
 */
export async function openPlaybackStream(
  rawUrl,
  {
    signal = null,
    fetchImpl = fetch,
    headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
  } = {}
) {
  let currentUrl = rawUrl;
  let response = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedMediaUrl(currentUrl)) {
      throw new MediaSourceError(
        MEDIA_ERROR.URL_REJECTED,
        "歌曲媒体地址不在允许范围内"
      );
    }
    if (signal?.aborted) {
      throw new MediaSourceError(MEDIA_ERROR.ABORTED, "播放已中止");
    }

    const candidate = await fetchHeaders(currentUrl, {
      signal,
      fetchImpl,
      headerTimeoutMs,
    });

    if (REDIRECT_STATUSES.has(candidate.status)) {
      const location = candidate.headers?.get?.("location");
      // 重定向响应的 body 必须立即释放
      try {
        await candidate.body?.cancel?.();
      } catch {
        // 释放失败不影响流程
      }
      if (!location || hop === MAX_REDIRECTS) {
        throw new MediaSourceError(
          MEDIA_ERROR.URL_REJECTED,
          "歌曲媒体地址重定向异常"
        );
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    response = candidate;
    break;
  }

  if (!response) {
    throw new MediaSourceError(
      MEDIA_ERROR.URL_REJECTED,
      "歌曲媒体地址重定向次数过多"
    );
  }

  if (!response.ok) {
    try {
      await response.body?.cancel?.();
    } catch {
      // 释放失败不影响错误返回
    }
    throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "获取歌曲数据失败");
  }
  if (!response.body) {
    throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "歌曲数据为空");
  }

  // 外部 signal 直接绑定到 Node 流：中止即销毁整条 pipeline
  const options = signal ? { signal } : undefined;
  return Readable.fromWeb(response.body, options);
}
