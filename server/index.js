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
  destroyLoginSession,
  getCurrentUser,
  requireCaptain,
  requireMember,
  toPublicUser
} from "./auth-session.js";

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

      const positionNames = {
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

      res.json({
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

app.get("/api/auth/me",
  (req, res) => {
    try {
      const user = getCurrentUser(req);

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
      destroyLoginSession(req, res);

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

app.get("/api/channels", async (req, res) => {
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

app.post("/api/channels", (req, res) => {
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

app.get("/api/token", async (req, res) => {
  try {
    const { room, username } = req.query;

    if (!room || !username) {
      return res.status(400).json({
        error: "room and username are required",
      });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: username,
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