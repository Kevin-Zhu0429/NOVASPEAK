const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

export function isRegistrationEnabled(env = process.env) {
  const value = env.REGISTRATION_ENABLED;
  if (value === undefined || value === null || String(value).trim() === "") {
    return true;
  }
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

export function normalizeRegistrationInput(body = {}) {
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return { error: "请输入用户名和密码" };
  }
  const username = body.username.normalize("NFKC").trim();
  const password = body.password;
  if (username.length < 2 || username.length > 24) {
    return { error: "用户名必须为 2—24 个字符" };
  }
  if (/[\u0000-\u001F\u007F]/.test(username)) {
    return { error: "用户名包含无效字符" };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: "密码必须为 8—128 位" };
  }
  return {
    username,
    usernameKey: username.toLocaleLowerCase(),
    password,
  };
}

export function createRegistrationLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  function check(key) {
    const currentTime = now();
    const id = typeof key === "string" && key ? key : "unknown";
    let entry = entries.get(id);
    if (!entry || currentTime - entry.startedAt >= windowMs) {
      entry = { startedAt: currentTime, attempts: 0 };
      entries.set(id, entry);
    }
    if (entry.attempts >= maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((entry.startedAt + windowMs - currentTime) / 1000)
        ),
      };
    }
    entry.attempts += 1;
    if (entries.size > 5_000) {
      for (const [entryKey, value] of entries) {
        if (currentTime - value.startedAt >= windowMs) entries.delete(entryKey);
      }
    }
    return { allowed: true };
  }

  return { check, _entries: entries };
}
