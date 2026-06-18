import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import db from "./db.js";
import cookieParser from "cookie-parser";
import {
  hashPassword,
  verifyPassword,
} from "./auth-utils.js";
import {
  createLoginSession,
  destroyAllLoginSessions,
  destroyLoginSession,
  getAuthenticatedUser,
  getCurrentUser,
  requireAdmin,
  requireAuthenticated,
  requireCaptain,
  requireMember,
  requireRegistered,
  toPublicUser
} from "./auth-session.js";
import {
  createGuestSession,
  destroyGuestSession,
} from "./guest-auth.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDistPath = path.resolve(
  __dirname,
  "../client/dist"
);

const app = express();

// Cloudflare Tunnel 通过本机回环地址连接 Express
app.set("trust proxy", "loopback");

app.use(cors());
app.use(express.json());
app.use(cookieParser());

function getLiveKitHttpUrl() {
  const url = process.env.LIVEKIT_URL;

  if (!url) {
    throw new Error("LIVEKIT_URL is missing");
  }

  return url.replace("wss://", "https://").replace("ws://", "http://");
}

const roomService = new RoomServiceClient(
  getLiveKitHttpUrl(),
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

async function getChannelStatus(channel) {
  try {
    const participants = await roomService.listParticipants(channel.id);

    return {
      ...channel,
      participantCount: participants.length,
      participants: participants.map((p) => p.identity),
    };
  } catch (error) {
    return {
      ...channel,
      participantCount: 0,
      participants: [],
    };
  }
}

function normalizeNickname(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
}

const RESERVED_GUEST_NICKNAMES = new Set([
  "admin",
  "administrator",
  "system",
  "novaspeak",
  "novagaming",
  "guest",
  "visitor",
]);

const ACCOUNT_POSITIONS = new Set([
  "captain",
  "commander",
  "entry",
  "sniper",
  "support",
  "rifler",
  "freeman",
  "backup",
  "member",
]);

function normalizeAccountNickname(value) {
  if (typeof value !== "string") {
    return {
      error: "请输入新昵称",
    };
  }

  const nickname = value.normalize("NFKC").trim();

  if (nickname.length < 2 || nickname.length > 24) {
    return {
      error: "昵称必须为 2—24 个字符",
    };
  }

  if (/[\u0000-\u001F\u007F]/.test(nickname)) {
    return {
      error: "昵称包含无效字符",
    };
  }

  const nicknameKey = nickname.toLocaleLowerCase();

  if (RESERVED_GUEST_NICKNAMES.has(nicknameKey)) {
    return {
      error: "该昵称为系统保留昵称，请更换昵称",
    };
  }

  return {
    nickname,
    nicknameKey,
  };
}

function getAccountUser(userId) {
  return db.prepare(`
    SELECT
      id,
      username,
      username_key,
      display_name,
      password_hash,
      role
    FROM users
    WHERE id = ?
  `).get(userId);
}

function normalizeGuestNickname(value) {
  if (typeof value !== "string") {
    return {
      error: "请输入访客昵称",
    };
  }

  const nickname = value.normalize("NFKC").trim();

  if (nickname.length < 2 || nickname.length > 24) {
    return {
      error: "访客昵称必须为 2—24 个字符",
    };
  }

  if (/[\u0000-\u001F\u007F]/.test(nickname)) {
    return {
      error: "访客昵称包含无效字符",
    };
  }

  const nicknameKey = nickname.toLocaleLowerCase();

  if (RESERVED_GUEST_NICKNAMES.has(nicknameKey)) {
    return {
      error: "该昵称为系统保留昵称，请更换访客昵称",
    };
  }

  return {
    nickname,
    nicknameKey,
  };
}



app.post("/api/auth/member-login",
  async (req, res) => {
    try {
      const nickname =
        req.body?.nickname;

      const password =
        req.body?.password;

      if (
        typeof nickname !== "string" ||
        typeof password !== "string"
      ) {
        return res.status(400).json({
          error: "请输入游戏昵称和密码",
        });
      }

      const nicknameKey =
        normalizeNickname(nickname);

      if (
        nicknameKey.length < 1 ||
        nicknameKey.length > 30 ||
        password.length < 1 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error: "游戏昵称或密码格式不正确",
        });
      }

      const user = db.prepare(`
        SELECT
          id,
          username,
          username_key,
          display_name,
          password_hash,
          role
        FROM users
        WHERE username_key = ?
      `).get(nicknameKey);

      if (!user) {
        return res.status(401).json({
          error: "游戏昵称或密码错误",
        });
      }

      const passwordIsValid =
        await verifyPassword(
          password,
          user.password_hash
        );

      if (!passwordIsValid) {
        return res.status(401).json({
          error: "游戏昵称或密码错误",
        });
      }

      createLoginSession(
        user.id,
        req,
        res
      );
      destroyGuestSession(req, res);

      res.json({
        success: true,
        user: toPublicUser(user),
      });
    } catch (error) {
      console.error(
        "Member login error:",
        error
      );

      res.status(500).json({
        error: "登录失败，请稍后重试",
      });
    }
  }
);

app.post("/api/auth/guest-login",
  (req, res) => {
    try {
      const result = normalizeGuestNickname(
        req.body?.nickname
      );

      if (result.error) {
        return res.status(400).json({
          error: result.error,
        });
      }

      const existingUser = db.prepare(`
        SELECT id
        FROM users
        WHERE username_key = ?
      `).get(result.nicknameKey);

      if (existingUser) {
        return res.status(409).json({
          error: "该昵称属于正式战队成员，请更换访客昵称",
        });
      }

      destroyLoginSession(req, res);

      const user = createGuestSession(
        result.nickname,
        req,
        res
      );

      res.json({
        success: true,
        user,
      });
    } catch (error) {
      console.error(
        "Guest login error:",
        error
      );

      res.status(500).json({
        error: "访客登录失败，请稍后重试",
      });
    }
  }
);

app.get("/api/auth/me",
  (req, res) => {
    try {
      const user = getAuthenticatedUser(req);

      res.json({
        user,
      });
    } catch (error) {
      console.error(
        "GET /api/auth/me 失败：",
        error
      );

      res.status(500).json({
        error: "无法获取登录状态",
      });
    }
  }
);

app.post("/api/auth/logout",
  (req, res) => {
    try {
      destroyAllLoginSessions(req, res);

      res.json({
        success: true,
      });
    } catch (error) {
      console.error(
        "Logout error:",
        error
      );

      res.status(500).json({
        error: "退出登录失败",
      });
    }
  }
);

app.get("/api/account/me",
  requireRegistered,
  (req, res) => {
    try {
      const user = getAccountUser(req.authUser.id);

      if (!user) {
        return res.status(401).json({
          error: "正式成员账号不存在或已失效",
        });
      }

      res.json({
        user: toPublicUser(user),
      });
    } catch (error) {
      console.error("Get account error:", error);
      res.status(500).json({
        error: "获取账号信息失败",
      });
    }
  }
);

app.patch("/api/account/me",
  requireRegistered,
  async (req, res) => {
    try {
      const nicknameResult = normalizeAccountNickname(
        req.body?.nickname
      );
      const currentPassword = req.body?.currentPassword;

      if (nicknameResult.error) {
        return res.status(400).json({
          error: nicknameResult.error,
        });
      }

      if (typeof currentPassword !== "string") {
        return res.status(400).json({
          error: "请输入当前密码",
        });
      }

      const user = getAccountUser(req.authUser.id);

      if (
        !user ||
        !(await verifyPassword(
          currentPassword,
          user.password_hash
        ))
      ) {
        return res.status(401).json({
          error: "当前密码错误",
        });
      }

      const duplicateUser = db.prepare(`
        SELECT id
        FROM users
        WHERE username_key = ? AND id <> ?
      `).get(
        nicknameResult.nicknameKey,
        user.id
      );

      if (duplicateUser) {
        return res.status(409).json({
          error: "该昵称已被其他正式成员使用",
        });
      }

      const updateNickname = db.transaction(() => {
        db.prepare(`
          UPDATE users
          SET
            username = ?,
            username_key = ?,
            display_name = ?
          WHERE id = ?
        `).run(
          nicknameResult.nickname,
          nicknameResult.nicknameKey,
          nicknameResult.nickname,
          user.id
        );

        return getAccountUser(user.id);
      });

      const updatedUser = updateNickname();

      res.json({
        success: true,
        user: toPublicUser(updatedUser),
      });
    } catch (error) {
      console.error("Update account nickname error:", error);

      if (
        error?.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return res.status(409).json({
          error: "该昵称已被其他正式成员使用",
        });
      }

      res.status(500).json({
        error: "修改昵称失败",
      });
    }
  }
);

app.patch("/api/account/me/password",
  requireRegistered,
  async (req, res) => {
    try {
      const currentPassword = req.body?.currentPassword;
      const newPassword = req.body?.newPassword;
      const confirmPassword = req.body?.confirmPassword;

      if (
        typeof currentPassword !== "string" ||
        typeof newPassword !== "string" ||
        typeof confirmPassword !== "string"
      ) {
        return res.status(400).json({
          error: "请完整填写密码信息",
        });
      }

      if (newPassword.length < 8 || newPassword.length > 128) {
        return res.status(400).json({
          error: "新密码必须为 8—128 位",
        });
      }

      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          error: "两次输入的新密码不一致",
        });
      }

      const user = getAccountUser(req.authUser.id);
      const currentPasswordIsValid =
        user &&
        await verifyPassword(
          currentPassword,
          user.password_hash
        );

      if (!currentPasswordIsValid) {
        return res.status(401).json({
          error: "当前密码错误",
        });
      }

      if (
        await verifyPassword(
          newPassword,
          user.password_hash
        )
      ) {
        return res.status(400).json({
          error: "新密码不能与当前密码相同",
        });
      }

      const passwordHash = await hashPassword(newPassword);

      db.prepare(`
        UPDATE users
        SET password_hash = ?
        WHERE id = ?
      `).run(passwordHash, user.id);

      res.json({
        success: true,
        message: "密码修改成功",
      });
    } catch (error) {
      console.error("Update account password error:", error);
      res.status(500).json({
        error: "修改密码失败",
      });
    }
  }
);

app.put("/api/account/me/positions",
  requireAdmin,
  (req, res) => {
    try {
      const requestedPositions = req.body?.positions;

      if (!Array.isArray(requestedPositions)) {
        return res.status(400).json({
          error: "职位必须使用数组提交",
        });
      }

      if (
        requestedPositions.some(
          (position) => typeof position !== "string"
        )
      ) {
        return res.status(400).json({
          error: "职位格式不正确",
        });
      }

      const positions = [...new Set(requestedPositions)];

      if (positions.length < 1) {
        return res.status(400).json({
          error: "至少需要保留一个职位",
        });
      }

      const unknownPosition = positions.find(
        (position) => !ACCOUNT_POSITIONS.has(position)
      );

      if (unknownPosition) {
        return res.status(400).json({
          error: "包含未知的战队职位",
        });
      }

      const updatePositions = db.transaction(() => {
        db.prepare(`
          DELETE FROM user_positions
          WHERE user_id = ?
        `).run(req.authUser.id);

        const insertPosition = db.prepare(`
          INSERT INTO user_positions (
            user_id,
            position
          )
          VALUES (?, ?)
        `);

        for (const position of positions) {
          insertPosition.run(
            req.authUser.id,
            position
          );
        }

        return getAccountUser(req.authUser.id);
      });

      const updatedUser = updatePositions();

      res.json({
        success: true,
        user: toPublicUser(updatedUser),
      });
    } catch (error) {
      console.error("Update account positions error:", error);
      res.status(500).json({
        error: "修改职位失败",
      });
    }
  }
);

app.get("/api/channels", requireAuthenticated, async (req, res) => {
  try {
    const channels = db
      .prepare(`
        SELECT
          id,
          name,
          owner_id AS ownerId,
          is_default AS isDefault,
          created_at AS createdAt
        FROM channels
        ORDER BY
          is_default DESC,
          created_at ASC
      `)
      .all();

    const result = await Promise.all(
      channels.map((channel) =>
        getChannelStatus(channel)
      )
    );

    res.json(result);
  } catch (error) {
    console.error("Get channels error:", error);

    res.status(500).json({
      error: "failed to get channels",
    });
  }
});

app.post("/api/channels", requireRegistered, (req, res) => {
  try {
    const rawName = req.body?.name;

    if (typeof rawName !== "string") {
      return res.status(400).json({
        error: "频道名称不能为空",
      });
    }

    const channelName = rawName
      .normalize("NFKC")
      .trim();

    if (
      channelName.length < 1 ||
      channelName.length > 30
    ) {
      return res.status(400).json({
        error: "频道名称必须为 1—30 个字符",
      });
    }

    const nameKey = channelName.toLocaleLowerCase();

    const existingChannel = db
      .prepare(`
        SELECT id
        FROM channels
        WHERE name_key = ?
      `)
      .get(nameKey);

    if (existingChannel) {
      return res.status(409).json({
        error: "该频道已经存在",
      });
    }

    const newChannel = {
      id: `custom-${randomUUID()}`,
      name: channelName,
      nameKey,
      ownerId: null,
      createdAt: Date.now(),
    };

    db.prepare(`
      INSERT INTO channels (
        id,
        name,
        name_key,
        owner_id,
        is_default,
        created_at
      )
      VALUES (
        @id,
        @name,
        @nameKey,
        @ownerId,
        0,
        @createdAt
      )
    `).run(newChannel);

    res.status(201).json({
      id: newChannel.id,
      name: newChannel.name,
      participantCount: 0,
      participants: [],
    });
  } catch (error) {
    console.error("Create channel error:", error);

    res.status(500).json({
      error: "创建频道失败",
    });
  }
});

app.get("/api/token", requireAuthenticated, async (req, res) => {
  try {
    const { room } = req.query;

    if (typeof room !== "string" || !room.trim()) {
      return res.status(400).json({
        error: "room is required",
      });
    }

    const user = req.authUser;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: user.id,
        name: user.displayName,
        metadata: JSON.stringify({
          displayName: user.displayName,
          role: user.role,
          isGuest: user.isGuest,
          positions: user.positions || [],
        }),
      }
    );

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: process.env.LIVEKIT_URL,
    });
  } catch (error) {
    console.error("Token error:", error);

    res.status(500).json({
      error: "failed to create token",
    });
  }
});

app.get("/api/team/public-members",
  requireAuthenticated,
  (req, res) => {
    try {
      const members = db.prepare(`
        SELECT
          id,
          username,
          COALESCE(display_name, username) AS display_name,
          role
        FROM users
        ORDER BY
          CASE
            WHEN role = 'admin' THEN 0
            ELSE 1
          END,
          created_at ASC
      `).all();

      res.json({
        members: members.map((member) => {
          const publicUser = toPublicUser(member);

          return {
            id: publicUser.id,
            nickname: publicUser.nickname,
            displayName: publicUser.displayName,
            role: publicUser.role,
            positions: publicUser.positions,
            positionNames: publicUser.positionNames,
            position: publicUser.position,
            positionName: publicUser.positionName,
          };
        }),
      });
    } catch (error) {
      console.error(
        "Get public team members error:",
        error
      );

      res.status(500).json({
        error: "获取公开战队成员失败",
      });
    }
  }
);

app.get("/api/team/members",
  requireCaptain,
  (req, res) => {
    try {
      const members = db.prepare(`
        SELECT
          id,
          username AS memberId,
          COALESCE(display_name, username) AS displayName,
          role,
          position,
          created_at AS createdAt
        FROM users
        ORDER BY
          CASE
            WHEN role = 'admin' THEN 0
            ELSE 1
          END,
          created_at ASC
      `).all();

      const positionNames = {
        captain: "队长",
        commander: "指挥",
        entry: "突破手",
        sniper: "狙击手",
        member: "队员",
        rifler: "步枪手",
        support: "辅助",
        freeman: "自由人",
        backup: "替补",
      };

      res.json({
        members: members.map((member) => ({
          id: member.id,

          nickname:
            member.nickname,

          displayName:
            member.displayName,

          role:
            member.role === "admin"
              ? "captain"
              : "member",

          isCaptain:
            member.role === "admin",

          position:
            member.position,

          positionName:
            positionNames[
              member.position
            ] || "队员",

          createdAt:
            member.createdAt,
        })),
      });
    } catch (error) {
      console.error(
        "Get team members error:",
        error
      );

      res.status(500).json({
        error: "获取战队成员失败",
      });
    }
  }
);

app.post("/api/team/members",
  requireCaptain,
  async (req, res) => {
    try {
      const rawNickname = req.body?.nickname;

      const position = req.body?.position;

      const password =
        req.body?.password;

      if (
        typeof rawNickname !== "string" ||
        typeof position !== "string" ||
        typeof password !== "string"
      ) {
        return res.status(400).json({
          error: "请完整填写成员信息",
        });
      }

      const nickname = rawNickname
        .normalize("NFKC")
        .trim();

      if (
        nickname.length < 1 ||
        nickname.length > 30 ||
        /[\u0000-\u001F\u007F]/.test(
          nickname
        )
      ) {
        return res.status(400).json({
          error:
            "游戏昵称必须为 1—30 个有效字符",
        });
      }

      const allowedPositions = [
        "commander",
        "entry",
        "sniper",
        "member",
        "rifler",
        "support",
        "freeman",
        "backup",
      ];

      if (
        !allowedPositions.includes(position)
      ) {
        return res.status(400).json({
          error: "请选择有效的战队职位",
        });
      }

      if (
        nickname.length < 1 ||
        nickname.length > 30 ||
        /[\u0000-\u001F\u007F]/.test(nickname)
      ) {
        return res.status(400).json({
          error: "游戏昵称必须为 1—30 个有效字符",
        });
      }

      if (
        password.length < 8 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error:
            "初始密码必须为 8—128 位",
        });
      }

      const usernameKey = normalizeNickname(nickname);

      const existingUser = db.prepare(`
        SELECT id
        FROM users
        WHERE username_key = ?
      `).get(usernameKey);

      if (existingUser) {
        return res.status(409).json({
          error: "该成员已经存在",
        });
      }

      const newUser = {
        id: randomUUID(),

        username: nickname,
        usernameKey,

        displayName: nickname,

        position,

        passwordHash:
          await hashPassword(password),

        createdAt: Date.now(),
      };

      db.prepare(`
        INSERT INTO users (
          id,
          username,
          username_key,
          display_name,
          password_hash,
          role,
          position,
          created_at
        )
        VALUES (
          @id,
          @username,
          @usernameKey,
          @displayName,
          @passwordHash,
          'member',
          @position,
          @createdAt
        )
      `).run(newUser);

      res.status(201).json({
        member: {
          id: newUser.id,
          memberId: newUser.username,
          displayName:
            newUser.displayName,
          role: "member",
          isCaptain: false,
          position: newUser.position,
          positionName: {
            commander: "指挥",
            entry: "突破手",
            sniper: "狙击手",
            support: "辅助",
            rifler: "步枪手",
            freeman: "自由人",
            backup: "替补",
            member: "队员",
          }[newUser.position],
          createdAt:
            newUser.createdAt,
        },
      });
    } catch (error) {
      console.error(
        "Create team member error:",
        error
      );

      if (
        error?.code ===
        "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        return res.status(409).json({
          error: "该成员 ID 已经存在",
        });
      }

      res.status(500).json({
        error: "创建战队成员失败",
      });
    }
  }
);

app.use("/api", (req, res) => {
  res.status(404).json({
    error: `API 不存在：${req.method} ${req.originalUrl}`,
  });
});

// 提供 Vite 打包后的前端文件
app.use(express.static(clientDistPath));

// 不是 API 的 GET 请求都返回前端页面
app.use((req, res, next) => {
  if (
    req.method !== "GET" ||
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  res.sendFile(
    path.join(clientDistPath, "index.html")
  );
});


app.listen(process.env.PORT || 3001, () => {
  console.log(`Server running on port ${process.env.PORT || 3001}`);
});
