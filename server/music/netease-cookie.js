// 网易云 Cookie 规范化：兼容 Cookie 字符串和 Electron cookies.get() 对象数组，
// 输出标准 Cookie 请求头字符串。凭据只允许短暂存在于请求和内存中，
// 本模块不得写日志、不得把明文 Cookie 回传给前端。

export const NETEASE_COOKIE_ERROR = Object.freeze({
  INVALID_INPUT: "NETEASE_COOKIE_INVALID",
  MUSIC_U_MISSING: "NETEASE_MUSIC_U_MISSING",
});

// RFC 6265 cookie-name token；值不允许分号、逗号、空白和控制字符
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_PATTERN = new RegExp(
  "^[^\\s;,\\u0000-\\u001f\\u007f]+$"
);

const MAX_COOKIE_COUNT = 100;
const MAX_COOKIE_VALUE_LENGTH = 4096;

function sanitizeCookiePair(name, value) {
  if (typeof name !== "string" || typeof value !== "string") return null;
  const trimmedName = name.trim();
  let trimmedValue = value.trim();

  // 兼容双引号包裹的 cookie 值
  if (
    trimmedValue.length >= 2 &&
    trimmedValue.startsWith('"') &&
    trimmedValue.endsWith('"')
  ) {
    trimmedValue = trimmedValue.slice(1, -1);
  }

  if (!trimmedName || !COOKIE_NAME_PATTERN.test(trimmedName)) return null;
  if (
    !trimmedValue ||
    trimmedValue.length > MAX_COOKIE_VALUE_LENGTH ||
    !COOKIE_VALUE_PATTERN.test(trimmedValue)
  ) {
    return null;
  }

  return { name: trimmedName, value: trimmedValue };
}

function pairsFromCookieString(input) {
  const pairs = [];
  for (const part of input.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    pairs.push({
      name: part.slice(0, separator),
      value: part.slice(separator + 1),
    });
  }
  return pairs;
}

function pairsFromCookieArray(input) {
  const pairs = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    pairs.push({ name: item.name, value: item.value });
  }
  return pairs;
}

/**
 * 规范化网易云 Cookie。
 *
 * @param {string | Array<{name: string, value: string}>} input
 * @returns {{ ok: true, cookieHeader: string }
 *   | { ok: false, code: string, error: string }}
 */
export function normalizeNeteaseCookie(input) {
  let rawPairs;

  if (typeof input === "string" && input.trim()) {
    rawPairs = pairsFromCookieString(input);
  } else if (Array.isArray(input) && input.length > 0) {
    rawPairs = pairsFromCookieArray(input);
  } else {
    return {
      ok: false,
      code: NETEASE_COOKIE_ERROR.INVALID_INPUT,
      error: "网易云登录信息格式无效",
    };
  }

  if (rawPairs.length > MAX_COOKIE_COUNT) {
    return {
      ok: false,
      code: NETEASE_COOKIE_ERROR.INVALID_INPUT,
      error: "网易云登录信息格式无效",
    };
  }

  // 去重：同名 Cookie 保留最后一次出现的值（对应最近一次写入）
  const deduped = new Map();
  for (const pair of rawPairs) {
    const sanitized = sanitizeCookiePair(pair.name, pair.value);
    if (sanitized) deduped.set(sanitized.name, sanitized.value);
  }

  if (deduped.size === 0) {
    return {
      ok: false,
      code: NETEASE_COOKIE_ERROR.INVALID_INPUT,
      error: "网易云登录信息格式无效",
    };
  }

  const musicU = deduped.get("MUSIC_U");
  if (!musicU) {
    return {
      ok: false,
      code: NETEASE_COOKIE_ERROR.MUSIC_U_MISSING,
      error: "网易云登录信息不完整，请重新扫码登录",
    };
  }

  const cookieHeader = Array.from(deduped.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  return { ok: true, cookieHeader };
}
