// 网易云歌曲媒体流：安全校验 + 有界 HTTP Range 分块读取。
//
// 为什么不用一条长连接直接喂给 FFmpeg：LiveKit captureFrame 按实时节奏
// 产生背压，一条 CDN 响应会因此被拖到整首歌的时长，部分 CDN 会在 1–2
// 分钟后断开。这里每次快速下载一个固定大小的 Range 块，完整校验后关闭
// 该响应，再把这一块交给 FFmpeg。内存只保留当前块和一个预取块（默认合计
// 不超过 1 MiB），不缓存整首歌、不写临时文件，也不会在下游背压期间把
// “未发起网络读取”误判为 stall。

import { Readable, Transform } from "node:stream";

export const MEDIA_ERROR = Object.freeze({
  URL_REJECTED: "MEDIA_URL_REJECTED",
  HEADER_TIMEOUT: "MEDIA_HEADER_TIMEOUT",
  STALL_TIMEOUT: "MEDIA_STALL_TIMEOUT",
  FETCH_FAILED: "MEDIA_FETCH_FAILED",
  ABORTED: "MEDIA_ABORTED",
  TOO_LARGE: "MEDIA_TOO_LARGE",
  RANGE_UNSUPPORTED: "MEDIA_RANGE_UNSUPPORTED",
  RANGE_MISMATCH: "MEDIA_RANGE_MISMATCH",
  STREAM_INTERRUPTED: "MEDIA_STREAM_INTERRUPTED",
});

export class MediaSourceError extends Error {
  constructor(code, message, { cause, diagnostics } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MediaSourceError";
    this.code = code;
    if (diagnostics) this.diagnostics = Object.freeze({ ...diagnostics });
  }
}

export const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
// 标准音质下约几十秒音频：足够减少请求数，又不会带来明显首播等待。
export const DEFAULT_MEDIA_BLOCK_BYTES = 512 * 1024;
const DEFAULT_HEADER_TIMEOUT_MS = 15_000;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_BLOCK_ATTEMPTS = 3;
const DEFAULT_TOTAL_RETRIES = 8;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_REDIRECTS = 5;

const ALLOWED_MEDIA_ROOTS = Object.freeze(["music.126.net", "music.163.com"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

class RetryableBlockError extends Error {
  constructor(code, { cause, bytesTransferred = 0 } = {}) {
    super(code, cause ? { cause } : undefined);
    this.name = "RetryableBlockError";
    this.code = code;
    this.bytesTransferred = bytesTransferred;
  }
}

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
  if (/^\d+(\.\d+){3}$/.test(host)) return false;
  if (host.includes(":") || host.startsWith("[")) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  return ALLOWED_MEDIA_ROOTS.some(
    (root) => host === root || host.endsWith(`.${root}`)
  );
}

export function mediaUrlHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid-url";
  }
}

// 下游 Transform 只负责总字节上限。网络 stall 必须在 reader.read() 正在
// 等待网络数据时计算，不能在下游因 LiveKit 背压暂停时计算。
export function createByteLimitTransform({
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
} = {}) {
  let totalBytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        callback(new MediaSourceError(MEDIA_ERROR.TOO_LARGE, "歌曲文件过大"));
        return;
      }
      callback(null, chunk);
    },
  });
}

function causeCodeChain(error) {
  const codes = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && codes.length < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate =
      typeof current.code === "string" && /^[A-Z0-9_]+$/.test(current.code)
        ? current.code
        : current.name === "TypeError"
          ? "TYPE_ERROR"
          : null;
    if (candidate && !codes.includes(candidate)) codes.push(candidate);
    current = current.cause;
  }
  return codes;
}

function isTransientNetworkError(error) {
  if (!error || typeof error !== "object") return false;
  if (error instanceof RetryableBlockError) return true;
  if (error.name === "TypeError") return true;
  let current = error;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (TRANSIENT_NETWORK_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function abortedError() {
  return new MediaSourceError(MEDIA_ERROR.ABORTED, "播放已中止");
}

async function cancelBody(response, reader = null) {
  try {
    if (reader) await reader.cancel();
    else await response?.body?.cancel?.();
  } catch {
    // 释放失败不改变原始错误
  }
}

function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortedError());
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithHeaderTimeout(
  url,
  { rangeHeader, signal, fetchImpl, headerTimeoutMs, controller }
) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, headerTimeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Range: rangeHeader,
        "Accept-Encoding": "identity",
      },
    });
  } catch (error) {
    if (signal?.aborted) throw abortedError();
    if (timedOut) {
      throw new RetryableBlockError(MEDIA_ERROR.HEADER_TIMEOUT, { cause: error });
    }
    if (isTransientNetworkError(error)) {
      throw new RetryableBlockError(MEDIA_ERROR.FETCH_FAILED, { cause: error });
    }
    throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "获取歌曲数据失败", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function openRangeResponse(
  rawUrl,
  { start, end, signal, fetchImpl, headerTimeoutMs }
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener("abort", onAbort);
  const rangeHeader = `bytes=${start}-${end}`;
  let currentUrl = rawUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isAllowedMediaUrl(currentUrl)) {
        throw new MediaSourceError(
          MEDIA_ERROR.URL_REJECTED,
          "歌曲媒体地址不在允许范围内"
        );
      }
      if (signal?.aborted) throw abortedError();

      const response = await fetchWithHeaderTimeout(currentUrl, {
        rangeHeader,
        signal,
        fetchImpl,
        headerTimeoutMs,
        controller,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.("location");
        await cancelBody(response);
        if (!location || hop === MAX_REDIRECTS) {
          throw new MediaSourceError(
            MEDIA_ERROR.URL_REJECTED,
            "歌曲媒体地址重定向异常"
          );
        }
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new MediaSourceError(
            MEDIA_ERROR.URL_REJECTED,
            "歌曲媒体地址重定向异常"
          );
        }
        continue;
      }

      return { response, resolvedUrl: currentUrl, controller, cleanup };
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  cleanup();
  throw new MediaSourceError(
    MEDIA_ERROR.URL_REJECTED,
    "歌曲媒体地址重定向次数过多"
  );
}

const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i;

function validateRangeResponse(response, { start, requestedEnd, maxBytes }) {
  if (response.status === 200) {
    throw new MediaSourceError(
      MEDIA_ERROR.RANGE_UNSUPPORTED,
      "媒体服务器不支持安全分块读取"
    );
  }
  if (response.status !== 206) {
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new RetryableBlockError(`HTTP_${response.status}`);
    }
    throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "获取歌曲数据失败");
  }

  const rawContentRange = response.headers?.get?.("content-range") || "";
  const match = CONTENT_RANGE_RE.exec(rawContentRange.trim());
  if (!match) {
    throw new MediaSourceError(
      MEDIA_ERROR.RANGE_MISMATCH,
      "媒体分块响应不完整"
    );
  }

  const rangeStart = Number(match[1]);
  const rangeEnd = Number(match[2]);
  const totalBytes = Number(match[3]);
  if (
    !Number.isSafeInteger(rangeStart) ||
    !Number.isSafeInteger(rangeEnd) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    totalBytes > maxBytes ||
    rangeStart !== start ||
    rangeEnd < rangeStart ||
    rangeEnd > requestedEnd ||
    rangeEnd >= totalBytes
  ) {
    if (totalBytes > maxBytes) {
      throw new MediaSourceError(MEDIA_ERROR.TOO_LARGE, "歌曲文件过大");
    }
    throw new MediaSourceError(
      MEDIA_ERROR.RANGE_MISMATCH,
      "媒体分块范围不匹配"
    );
  }

  const expectedLength = rangeEnd - rangeStart + 1;
  const rawContentLength = response.headers?.get?.("content-length");
  if (rawContentLength !== null && rawContentLength !== undefined) {
    const contentLength = Number(rawContentLength);
    if (!Number.isSafeInteger(contentLength) || contentLength !== expectedLength) {
      throw new MediaSourceError(
        MEDIA_ERROR.RANGE_MISMATCH,
        "媒体分块长度不匹配"
      );
    }
  }
  return { expectedLength, totalBytes };
}

function readWithStallTimeout(reader, { stallTimeoutMs, controller, signal }) {
  if (signal?.aborted) return Promise.reject(abortedError());
  if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) {
    return reader.read();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      controller.abort();
      settle(reject, abortedError());
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle(
        reject,
        new RetryableBlockError(MEDIA_ERROR.STALL_TIMEOUT)
      );
    }, stallTimeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => settle(resolve, result),
      (error) => {
        if (signal?.aborted) settle(reject, abortedError());
        else if (isTransientNetworkError(error)) {
          settle(
            reject,
            new RetryableBlockError(MEDIA_ERROR.FETCH_FAILED, { cause: error })
          );
        } else settle(reject, error);
      }
    );
  });
}

async function readCompleteBlock(
  response,
  { expectedLength, stallTimeoutMs, controller, signal }
) {
  if (!response.body) {
    throw new RetryableBlockError(MEDIA_ERROR.FETCH_FAILED);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await readWithStallTimeout(reader, {
        stallTimeoutMs,
        controller,
        signal,
      });
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > expectedLength) {
        throw new MediaSourceError(
          MEDIA_ERROR.RANGE_MISMATCH,
          "媒体分块长度不匹配"
        );
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    if (received !== expectedLength) {
      throw new RetryableBlockError(MEDIA_ERROR.FETCH_FAILED, {
        bytesTransferred: received,
      });
    }
    return Buffer.concat(chunks, expectedLength);
  } catch (error) {
    await cancelBody(response, reader);
    if (signal?.aborted) throw abortedError();
    if (error instanceof MediaSourceError || error instanceof RetryableBlockError) {
      if (error instanceof RetryableBlockError && !error.bytesTransferred) {
        error.bytesTransferred = received;
      }
      throw error;
    }
    if (isTransientNetworkError(error)) {
      throw new RetryableBlockError(MEDIA_ERROR.FETCH_FAILED, {
        cause: error,
        bytesTransferred: received,
      });
    }
    throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "读取歌曲数据失败", {
      cause: error,
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader 可能已经被取消
    }
  }
}

function interruptedError(error, { url, attemptCount, start }) {
  return new MediaSourceError(
    MEDIA_ERROR.STREAM_INTERRUPTED,
    "歌曲数据连接反复中断",
    {
      cause: error,
      diagnostics: {
        hostname: mediaUrlHostname(url),
        attemptCount,
        blockStart: start,
        bytesTransferred: Number(error?.bytesTransferred) || 0,
        causeCodeChain: causeCodeChain(error),
      },
    }
  );
}

async function downloadBlock({
  url,
  start,
  requestedEnd,
  signal,
  fetchImpl,
  headerTimeoutMs,
  stallTimeoutMs,
  maxBytes,
  maxBlockAttempts,
  maxTotalRetries,
  retryDelayMs,
  retryState,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxBlockAttempts; attempt += 1) {
    if (signal?.aborted) throw abortedError();
    let opened = null;
    try {
      opened = await openRangeResponse(url, {
        start,
        end: requestedEnd,
        signal,
        fetchImpl,
        headerTimeoutMs,
      });
      const range = validateRangeResponse(opened.response, {
        start,
        requestedEnd,
        maxBytes,
      });
      const data = await readCompleteBlock(opened.response, {
        expectedLength: range.expectedLength,
        stallTimeoutMs,
        controller: opened.controller,
        signal,
      });
      return {
        data,
        totalBytes: range.totalBytes,
        resolvedUrl: opened.resolvedUrl,
      };
    } catch (error) {
      lastError = error;
      if (opened?.response) await cancelBody(opened.response);
      if (signal?.aborted || error?.code === MEDIA_ERROR.ABORTED) {
        throw abortedError();
      }
      if (!(error instanceof RetryableBlockError)) throw error;

      const canRetryBlock = attempt < maxBlockAttempts;
      const canRetrySong = retryState.count < maxTotalRetries;
      if (!canRetryBlock || !canRetrySong) {
        throw interruptedError(error, {
          url: opened?.resolvedUrl || url,
          attemptCount: attempt,
          start,
        });
      }
      retryState.count += 1;
      await waitForRetry(retryDelayMs * 2 ** (attempt - 1), signal);
    } finally {
      opened?.cleanup?.();
    }
  }
  throw interruptedError(lastError, {
    url,
    attemptCount: maxBlockAttempts,
    start,
  });
}

/**
 * 打开逻辑歌曲流。每个 Range 块在 yield 前完整下载、校验并关闭响应；
 * 下游背压只会推迟下一块请求，不会让现有 CDN 连接空闲数分钟。
 */
export async function openPlaybackStream(
  rawUrl,
  {
    signal: outerSignal = null,
    fetchImpl = fetch,
    headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    blockBytes = DEFAULT_MEDIA_BLOCK_BYTES,
    maxBytes = DEFAULT_MAX_MEDIA_BYTES,
    maxBlockAttempts = DEFAULT_BLOCK_ATTEMPTS,
    maxTotalRetries = DEFAULT_TOTAL_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {}
) {
  if (!isAllowedMediaUrl(rawUrl)) {
    throw new MediaSourceError(
      MEDIA_ERROR.URL_REJECTED,
      "歌曲媒体地址不在允许范围内"
    );
  }
  if (outerSignal?.aborted) throw abortedError();
  if (!Number.isSafeInteger(blockBytes) || blockBytes <= 0) {
    throw new TypeError("blockBytes must be a positive integer");
  }

  const lifecycleController = new AbortController();
  const signal = lifecycleController.signal;

  const retryState = { count: 0 };
  const beginBlockDownload = (params) =>
    downloadBlock(params).then(
      (block) => ({ block, error: null }),
      (error) => ({ block: null, error })
    );

  async function* blocks() {
    let start = 0;
    let totalBytes = null;
    let currentUrl = rawUrl;
    const makeDownload = () => {
      const requestedEnd = Math.min(
        start + blockBytes - 1,
        maxBytes - 1
      );
      return beginBlockDownload({
        url: currentUrl,
        start,
        requestedEnd,
        signal,
        fetchImpl,
        headerTimeoutMs,
        stallTimeoutMs,
        maxBytes,
        maxBlockAttempts,
        maxTotalRetries,
        retryDelayMs,
        retryState,
      });
    };

    let pendingDownload = makeDownload();
    while (pendingDownload) {
      if (signal?.aborted) throw abortedError();
      // Promise 被包装为 outcome，即使下游长时间背压或流被销毁，预取失败
      // 也不会产生 unhandledRejection。
      const outcome = await pendingDownload;
      if (outcome.error) throw outcome.error;
      const block = outcome.block;
      if (totalBytes !== null && block.totalBytes !== totalBytes) {
        throw new MediaSourceError(
          MEDIA_ERROR.RANGE_MISMATCH,
          "媒体文件长度在播放期间发生变化"
        );
      }
      totalBytes = block.totalBytes;
      currentUrl = block.resolvedUrl;
      start += block.data.length;
      // 在当前块交给 FFmpeg 前启动下一块的快速下载。这样 FFmpeg 消费当前
      // 块时已有一个有界预取块，Range 边界不会产生可听见的网络等待。
      pendingDownload = start < totalBytes ? makeDownload() : null;
      yield block.data;
    }
  }

  const stream = Readable.from(blocks(), {
    objectMode: false,
    // 一个块写入下游后立即触发背压，避免预取第二块。
    highWaterMark: Math.min(blockBytes, 64 * 1024),
  });
  // Readable.from() 的默认 destroy 会等待 async generator 当前的 await。
  // 预取若正卡在 reader.read()，必须先中止内部请求，再进入默认销毁流程。
  const nativeDestroy = stream.destroy.bind(stream);
  stream.destroy = (error) => {
    lifecycleController.abort();
    return nativeDestroy(error);
  };
  const onOuterAbort = () => stream.destroy(abortedError());
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  stream.once("close", () => {
    // 正常结束也清理可能刚启动、尚未进入下一轮 yield 的预取请求。
    lifecycleController.abort();
    outerSignal?.removeEventListener("abort", onOuterAbort);
  });
  return stream;
}
