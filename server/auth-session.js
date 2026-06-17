import db from "./db.js";

import {
  createSessionToken,
  hashSessionToken,
} from "./auth-utils.js";

export const SESSION_COOKIE_NAME = "novaspeak_session";

// 登录状态有效期：7 天
const SESSION_DURATION_MS =
  7 * 24 * 60 * 60 * 1000;

/**
 * 数据库用户转换为可以发送给前端的安全对象。
 * 不返回密码哈希。
 */
const POSITION_NAMES = {
  captain: "队长",
  commander: "指挥",
  entry: "突破手",
  sniper: "狙击手",
  support: "辅助",
  rifler: "步枪手",
  freeman: "自由人",
  backup: "替补",
  member: "队员",
};

export function toPublicUser(user) {
  const position =
    user.position ||
    (user.role === "admin"
      ? "captain"
      : "member");

  return {
    id: user.id,

    nickname: user.username,

    // 暂时保留 displayName，
    // 避免已有频道代码需要全部修改
    displayName:
      user.display_name ||
      user.username,

    role:
      user.role === "admin"
        ? "captain"
        : "member",

    isCaptain:
      user.role === "admin",

    position,

    positionName:
      POSITION_NAMES[position] ||
      "队员",
  };
}
  

/**
 * 根据当前请求判断是否为 HTTPS。
 *
 * 线上：
 * Cloudflare HTTPS → Tunnel → 本地 Express
 *
 * 本地：
 * http://localhost:3001
 */
function isSecureRequest(req) {
  return req.secure === true;
}

function getCookieOptions(req) {
  return {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
  };
}

/**
 * 登录成功后创建新会话。
 */
export function createLoginSession(
  userId,
  req,
  res
) {
  const now = Date.now();
  const expiresAt = now + SESSION_DURATION_MS;

  // 顺便清理所有过期会话
  db.prepare(`
    DELETE FROM sessions
    WHERE expires_at <= ?
  `).run(now);

  const sessionToken = createSessionToken();
  const tokenHash =
    hashSessionToken(sessionToken);

  db.prepare(`
    INSERT INTO sessions (
      token_hash,
      user_id,
      expires_at,
      created_at
    )
    VALUES (
      @tokenHash,
      @userId,
      @expiresAt,
      @createdAt
    )
  `).run({
    tokenHash,
    userId,
    expiresAt,
    createdAt: now,
  });

  res.cookie(
    SESSION_COOKIE_NAME,
    sessionToken,
    {
      ...getCookieOptions(req),
      maxAge: SESSION_DURATION_MS,
    }
  );
}

/**
 * 根据请求中的 Cookie 查询当前登录用户。
 */
export function getCurrentUser(req) {
  const sessionToken =
    req.cookies?.[SESSION_COOKIE_NAME];

  if (!sessionToken) {
    return null;
  }

  const tokenHash =
    hashSessionToken(sessionToken);

  const session = db.prepare(`
    SELECT
      sessions.token_hash AS tokenHash,
      sessions.expires_at AS expiresAt,

      users.id,
      users.username,
      users.display_name,
      users.role,
      users.position

    FROM sessions

    INNER JOIN users
      ON users.id = sessions.user_id

    WHERE sessions.token_hash = ?
  `).get(tokenHash);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    db.prepare(`
      DELETE FROM sessions
      WHERE token_hash = ?
    `).run(tokenHash);

    return null;
  }

  return toPublicUser(session);
}

/**
 * 删除当前浏览器会话。
 */
export function destroyLoginSession(
  req,
  res
) {
  const sessionToken =
    req.cookies?.[SESSION_COOKIE_NAME];

  if (sessionToken) {
    const tokenHash =
      hashSessionToken(sessionToken);

    db.prepare(`
      DELETE FROM sessions
      WHERE token_hash = ?
    `).run(tokenHash);
  }

  res.clearCookie(
    SESSION_COOKIE_NAME,
    getCookieOptions(req)
  );
}

/**
 * 后续保护接口时使用。
 */
export function requireMember(
  req,
  res,
  next
) {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      error: "请先登录",
    });
  }

  req.authUser = user;
  next();
}

/**
 * 后续“战队管理”接口使用。
 */
export function requireCaptain(
  req,
  res,
  next
) {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      error: "请先登录",
    });
  }

  if (!user.isCaptain) {
    return res.status(403).json({
      error: "只有队长可以执行该操作",
    });
  }

  req.authUser = user;
  next();
}