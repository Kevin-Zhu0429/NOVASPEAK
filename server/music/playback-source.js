import { Readable } from "node:stream";
import net from "node:net";

export const MEDIA_ERROR = Object.freeze({
  URL_REJECTED: "MEDIA_URL_REJECTED",
  FETCH_FAILED: "MEDIA_FETCH_FAILED",
  TOO_LARGE: "MEDIA_TOO_LARGE",
  TIMEOUT: "MEDIA_TIMEOUT",
  ABORTED: "MEDIA_ABORTED",
});

export class MediaSourceError extends Error {
  constructor(code, message) { super(message); this.name = "MediaSourceError"; this.code = code; }
}

export const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const ALLOWED_NETEASE_MEDIA_HOSTS = ["music.126.net", "music.163.com"];

function hasAllowedBoundary(hostname, allowed) {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export function validateNeteaseMediaUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址不可用");
  let url;
  try { url = new URL(rawUrl); } catch { throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址不可用"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址协议不允许");
  if (url.username || url.password) throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址不允许包含凭据");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || net.isIP(hostname)) throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址主机不允许");
  if (!ALLOWED_NETEASE_MEDIA_HOSTS.some((allowed) => hasAllowedBoundary(hostname, allowed))) throw new MediaSourceError(MEDIA_ERROR.URL_REJECTED, "媒体地址域名不允许");
  return url.toString();
}

function anySignal(signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

async function fetchWithTimeout(fetchImpl, url, { signal, timeoutMs }) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  let timer;
  const timeoutSignal = timeout || (() => {
    const c = new AbortController();
    timer = setTimeout(() => c.abort(), timeoutMs); timer.unref?.();
    return c.signal;
  })();
  try {
    return await fetchImpl(url, { redirect: "manual", signal: anySignal([signal, timeoutSignal]) });
  } catch (error) {
    if (signal?.aborted) throw new MediaSourceError(MEDIA_ERROR.ABORTED, "媒体读取已中止");
    throw new MediaSourceError(timeoutSignal.aborted ? MEDIA_ERROR.TIMEOUT : MEDIA_ERROR.FETCH_FAILED, timeoutSignal.aborted ? "媒体下载超时" : "媒体下载失败");
  } finally { if (timer) clearTimeout(timer); }
}

export async function openNeteaseMediaStream({ url, fetchImpl = globalThis.fetch, signal = null, maxBytes = DEFAULT_MAX_MEDIA_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "当前运行环境不支持 fetch");
  let current = validateNeteaseMediaUrl(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchWithTimeout(fetchImpl, current, { signal, timeoutMs });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.("location");
      if (!location) throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "媒体重定向无效");
      current = validateNeteaseMediaUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "媒体下载失败");
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > maxBytes) throw new MediaSourceError(MEDIA_ERROR.TOO_LARGE, "媒体文件过大");
    const body = response.body;
    if (!body) throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "媒体响应为空");
    const nodeStream = typeof body.getReader === "function" ? Readable.fromWeb(body) : body;
    let total = 0;
    const limited = new Readable({ read() {} });
    nodeStream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        limited.destroy(new MediaSourceError(MEDIA_ERROR.TOO_LARGE, "媒体文件过大"));
        nodeStream.destroy?.();
        return;
      }
      if (!limited.push(chunk)) nodeStream.pause?.();
    });
    limited.on("drain", () => nodeStream.resume?.());
    nodeStream.on("end", () => limited.push(null));
    nodeStream.on("error", (e) => limited.destroy(e));
    signal?.addEventListener("abort", () => {
      nodeStream.destroy?.();
      limited.destroy(new MediaSourceError(MEDIA_ERROR.ABORTED, "媒体读取已中止"));
    }, { once: true });
    return { stream: limited, contentLength: length || null };
  }
  throw new MediaSourceError(MEDIA_ERROR.FETCH_FAILED, "媒体重定向次数过多");
}
