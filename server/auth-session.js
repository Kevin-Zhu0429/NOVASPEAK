import db from "./db.js";

import {
  createSessionToken,
  hashSessionToken,
} from "./auth-utils.js";
import {
  destroyGuestSession,
  getGuestUser,
} from "./guest-auth.js";
import { avatarUrlFromPath } from "./avatar.js";
import {
  canManageChannels,
  getRoleLabel,
} from "./authorization.js";

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

function getUserPositions(userId) {
  return db.prepare(`
    SELECT position
    FROM user_positions
    WHERE user_id = ?
    ORDER BY
      CASE position
        WHEN 'captain' THEN 1
        WHEN 'commander' THEN 2
        WHEN 'entry' THEN 3
        WHEN 'sniper' THEN 4
        WHEN 'support' THEN 5
        WHEN 'rifler' THEN 6
        WHEN 'freeman' THEN 7
        WHEN 'backup' THEN 8
        WHEN 'member' THEN 9
        ELSE 99
      END
  `).all(userId).map((item) => item.position);
}

export function toPublicUser(user) {
  if (!user) {
    return null;
  }

  const positions =
    user.role === "user"
      ? []
      : getUserPositions(user.id);

  const positionNames = positions.map(
    (position) => POSITION_NAMES[position] || position
  );

  const nickname =
    user.display_name ||
    user.username ||
    "";

  return {
    id: user.id,

    nickname,
    displayName: nickname,

    // 真正的账号权限
    role: user.role,

    isAdmin: user.role === "admin",

    // 暂时保留，避免现有前端报错
    isCaptain: user.role === "admin",

    isGuest: false,
    roleLabel: getRoleLabel(user.role),

    // 新的多职位字段
    positions,
    positionNames,

    // 头像公开 URL；未设置时为 null，不暴露磁盘路径
    avatarUrl: avatarUrlFromPath(user.avatar_path),

    // 暂时保留旧字段，兼容欢迎动画
    position: positions[0] || (user.role === "user" ? null : "member"),
    positionName:
      positionNames[0] ||
      (user.role === "user" ? null : POSITION_NAMES.member),
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
      users.avatar_path

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

export function getAuthenticatedUser(req) {
  const registeredUser = getCurrentUser(req);

  if (registeredUser) {
    return registeredUser;
  }

  return getGuestUser(req);
}

export function parseRequestCookies(req) {
  if (req.cookies) {
    return req.cookies;
  }

  const cookies = {};
  const header = req.headers?.cookie;

  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 1) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }

  req.cookies = cookies;
  return cookies;
}

export function resolveAuthenticatedIdentity(req) {
  parseRequestCookies(req);
  return getAuthenticatedUser(req);
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

export function destroyAllLoginSessions(req, res) {
  destroyLoginSession(req, res);
  destroyGuestSession(req, res);
}

export function revokeOtherLoginSessions(userId, req) {
  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!sessionToken) {
    return db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
  return db.prepare(`
    DELETE FROM sessions
    WHERE user_id = ? AND token_hash <> ?
  `).run(userId, hashSessionToken(sessionToken));
}

/**
 * 后续保护接口时使用。
 */
export function requireMember(
  req,
  res,
  next
) {
  const user = resolveAuthenticatedIdentity(req);

  if (!user) {
    return res.status(401).json({
      error: "请先登录",
    });
  }

  req.authUser = user;
  next();
}

export function requireAuthenticated(req, res, next) {
  return requireMember(req, res, next);
}

export function requireRegistered(req, res, next) {
  const user = getCurrentUser(req);

  if (!user) {
    if (getGuestUser(req)) {
      return res.status(403).json({
        error: "该功能仅限正式账号",
      });
    }

    return res.status(401).json({
      error: "请先登录正式成员账号",
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

  if (user.role !== "admin") {
    return res.status(403).json({
      error: "只有管理员可以执行该操作",
    });
  }

  req.authUser = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = getCurrentUser(req);

  if (!user) {
    if (getGuestUser(req)) {
      return res.status(403).json({
        error: "该功能仅限管理员",
      });
    }

    return res.status(401).json({
      error: "请先登录正式成员账号",
    });
  }

  if (user.role !== "admin") {
    return res.status(403).json({
      error: "只有管理员可以执行该操作",
    });
  }

  req.authUser = user;
  next();
}

export function requireChannelManager(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) {
    if (getGuestUser(req)) {
      return res.status(403).json({
        error: "该功能仅限管理员和战队成员",
      });
    }
    return res.status(401).json({
      error: "请先登录正式账号",
    });
  }
  if (!canManageChannels(user.role)) {
    return res.status(403).json({
      error: "普通用户不能管理频道",
    });
  }
  req.authUser = user;
  next();
}
