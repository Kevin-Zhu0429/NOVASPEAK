import path from "node:path";
import { createServer } from "node:http";
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
  requireMember,
  requireRegistered,
  toPublicUser
} from "./auth-session.js";
import {
  createGuestSession,
  destroyGuestSession,
} from "./guest-auth.js";
import { createPresenceService } from "./presence.js";
import { createVoiceManagementService } from "./voice-management.js";
import {
  AVATAR_UPLOAD_BODY_LIMIT,
  createAvatarService,
} from "./avatar.js";
import {
  assertChannelCapacity,
  buildChannelPatch,
  canEnterChannel,
  getChannelById,
  getChannelParticipantCount,
  listChannelRows,
  normalizeChannelName,
  reorderChannels,
  toPublicChannel,
} from "./channels.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDistPath = path.resolve(
  __dirname,
  "../client/dist"
);

// 头像上传目录；测试环境通过 NOVASPEAK_UPLOADS_DIR 指向临时目录
const uploadsDirectory = process.env.NOVASPEAK_UPLOADS_DIR
  ? path.resolve(process.env.NOVASPEAK_UPLOADS_DIR)
  : path.join(__dirname, "uploads");

const avatarsDirectory = path.join(uploadsDirectory, "avatars");

const app = express();

// Cloudflare Tunnel 通过本机回环地址连接 Express
app.set("trust proxy", "loopback");

app.use(cors());

// 头像上传使用 JSON base64，需要比默认 100kb 更大的请求体上限
app.use("/api/me/avatar", express.json({ limit: AVATAR_UPLOAD_BODY_LIMIT }));

app.use(express.json());
app.use(cookieParser());

// 只暴露 server/uploads/avatars 一个目录，不暴露整个 server 目录；
// fallthrough: false 让缺失的头像直接进入下方 JSON 404，而不是落入 SPA 页面
app.use(
  "/uploads/avatars",
  express.static(avatarsDirectory, {
    fallthrough: false,
    index: false,
    dotfiles: "ignore",
    maxAge: "1d",
  })
);

app.use("/uploads", (req, res) => {
  res.status(404).json({ error: "文件不存在" });
});

app.use("/uploads", (error, req, res, next) => {
  const status =
    Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
      ? error.status
      : 404;
  res.status(status).json({ error: "头像文件不存在" });
});

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

const presence = createPresenceService();

const avatarService = createAvatarService({
  db,
  avatarsDirectory,
});

const voiceManagement = createVoiceManagementService({
  roomService,
  presenceService: presence,
  channelLookup: (id) => db.prepare("SELECT id, name FROM channels WHERE id = ?").get(id),
});

function normalizeVoiceConnectionId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{12,80}$/.test(trimmed) ? trimmed : "";
}

function getVoiceParticipantIdentity(user, voiceConnectionId) {
  const connectionId = normalizeVoiceConnectionId(voiceConnectionId);
  return connectionId ? `${user.id}:voice:${connectionId}` : user.id;
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
      role,
      avatar_path,
      created_at
    FROM users
    WHERE id = ?
  `).get(userId);
}

function toManagedMember(user) {
  const publicUser = toPublicUser(user);

  return {
    ...publicUser,
    createdAt: user.created_at,
  };
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
          role,
          avatar_path
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

app.post("/api/me/avatar",
  requireRegistered,
  (req, res) => {
    try {
      const result = avatarService.saveAvatarForUser(
        req.authUser.id,
        req.body
      );

      if (result.error) {
        return res.status(result.status || 400).json({
          error: result.error,
        });
      }

      res.json({
        success: true,
        user: toPublicUser(getAccountUser(req.authUser.id)),
      });
    } catch (error) {
      console.error("Upload avatar error:", error?.message || error);
      res.status(500).json({
        error: "上传头像失败，请稍后重试",
      });
    }
  }
);

app.delete("/api/me/avatar",
  requireRegistered,
  (req, res) => {
    try {
      const result = avatarService.deleteAvatarForUser(req.authUser.id);

      if (result.error) {
        return res.status(result.status || 400).json({
          error: result.error,
        });
      }

      res.json({
        success: true,
        user: toPublicUser(getAccountUser(req.authUser.id)),
      });
    } catch (error) {
      console.error("Delete avatar error:", error?.message || error);
      res.status(500).json({
        error: "删除头像失败，请稍后重试",
      });
    }
  }
);

// 头像请求体解析错误（过大 / 非法 JSON）统一返回中文 JSON
app.use("/api/me/avatar", (error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      error: "头像文件不能超过 2MB",
    });
  }

  console.error("Avatar request body error:", error?.type || error?.message);
  res.status(400).json({
    error: "头像上传数据格式不正确",
  });
});

app.get("/api/channels", requireAuthenticated, (req, res) => {
  console.info("[channel-list] request-start");
  try {
    const channels = listChannelRows(db).map(toPublicChannel);
    console.info("[channel-list] db-query-success");
    console.info("[channel-list] response-success");
    res.json(channels);
  } catch (error) {
    console.error("[channel-list] failed", {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
    res.status(500).json({ error: "获取频道列表失败" });
  }
});

app.post("/api/channels", requireRegistered, (req, res) => {
  try {
    const normalized = normalizeChannelName(req.body?.name);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const existingChannel = db.prepare(`SELECT id FROM channels WHERE name_key = ?`).get(normalized.nameKey);
    if (existingChannel) return res.status(409).json({ error: "该频道已经存在" });
    const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -10) AS maxOrder FROM channels").get().maxOrder;
    const newChannel = {
      id: `custom-${randomUUID()}`,
      name: normalized.name,
      nameKey: normalized.nameKey,
      ownerId: req.authUser.id,
      sortOrder: maxOrder + 10,
      createdAt: Date.now(),
    };
    db.prepare(`
      INSERT INTO channels (id, name, name_key, owner_id, is_default, description, sort_order, max_members, access_level, allow_guests, is_system, created_at)
      VALUES (@id, @name, @nameKey, @ownerId, 0, '', @sortOrder, NULL, 'everyone', 1, 0, @createdAt)
    `).run(newChannel);
    res.status(201).json({ ...toPublicChannel(getChannelById(db, newChannel.id)), participantCount: 0, participants: [] });
  } catch (error) {
    console.error("Create channel error:", error);
    res.status(500).json({ error: "创建频道失败" });
  }
});


app.patch("/api/channels/reorder", requireAdmin, (req, res) => {
  try {
    const beforeRows = listChannelRows(db);
    console.info("[channel-reorder] before", beforeRows.map((channel) => ({ id: channel.id, sortOrder: channel.sort_order })));
    const result = reorderChannels(db, req.body?.channelIds);
    if (result.error) return res.status(400).json({ error: result.error });
    console.info("[channel-reorder] after", result.channels.map((channel) => ({ id: channel.id, sortOrder: channel.sortOrder })));
    res.json({ success: true, channels: result.channels });
  } catch (error) {
    console.error("Reorder channels error:", { name: error?.name, message: error?.message, code: error?.code });
    res.status(500).json({ error: "调整频道排序失败" });
  }
});

app.patch("/api/channels/:channelId", requireAdmin, (req, res) => {
  try {
    const channel = getChannelById(db, req.params.channelId);
    if (!channel) return res.status(404).json({ error: "频道不存在" });
    const patch = buildChannelPatch(req.body);
    if (patch.error) return res.status(400).json({ error: patch.error });
    if (patch.nameKey) {
      const existing = db.prepare("SELECT id FROM channels WHERE name_key = ? AND id <> ?").get(patch.nameKey, channel.id);
      if (existing) return res.status(409).json({ error: "该频道已经存在" });
    }
    db.prepare(`
      UPDATE channels SET
        name = COALESCE(@name, name),
        name_key = COALESCE(@nameKey, name_key),
        description = COALESCE(@description, description),
        sort_order = COALESCE(@sortOrder, sort_order),
        max_members = @maxMembersValue,
        access_level = COALESCE(@accessLevel, access_level),
        allow_guests = COALESCE(@allowGuests, allow_guests)
      WHERE id = @id
    `).run({
      id: channel.id,
      name: patch.name ?? null,
      nameKey: patch.nameKey ?? null,
      description: patch.description ?? null,
      sortOrder: patch.sortOrder ?? null,
      maxMembersValue: Object.hasOwn(patch, "maxMembers") ? patch.maxMembers : channel.max_members,
      accessLevel: patch.accessLevel ?? null,
      allowGuests: Object.hasOwn(patch, "allowGuests") ? (patch.allowGuests ? 1 : 0) : null,
    });
    res.json({ success: true, channel: toPublicChannel(getChannelById(db, channel.id)) });
  } catch (error) {
    console.error("Update channel error:", error);
    res.status(500).json({ error: "修改频道失败" });
  }
});

app.delete("/api/channels/:channelId", requireAdmin, async (req, res) => {
  try {
    const channel = getChannelById(db, req.params.channelId);
    if (!channel) return res.status(404).json({ error: "频道不存在" });
    if (channel.is_system) return res.status(409).json({ error: "系统默认频道不能删除" });
    let participantCount;
    try {
      participantCount = await getChannelParticipantCount(roomService, channel.id);
    } catch (error) {
      console.error("Check channel occupancy error:", { name: error?.name, message: error?.message, code: error?.code });
      return res.status(503).json({ error: "暂时无法确认频道占用状态，请稍后再试" });
    }
    if (participantCount > 0) return res.status(409).json({ error: "频道内仍有成员，无法删除" });
    db.prepare("DELETE FROM channels WHERE id = ?").run(channel.id);
    res.json({ ok: true, deletedChannelId: channel.id });
  } catch (error) {
    console.error("Delete channel error:", error);
    res.status(500).json({ error: "删除频道失败" });
  }
});

app.get("/api/token", requireAuthenticated, async (req, res) => {
  try {
    const { room } = req.query;

    if (typeof room !== "string" || !room.trim()) {
      return res.status(400).json({
        error: "请选择有效的语音频道",
      });
    }

    const channel = getChannelById(db, room.trim());

    if (!channel) {
      return res.status(404).json({
        error: "语音频道不存在",
      });
    }

    const user = req.authUser;

    if (!canEnterChannel(channel, user)) {
      return res.status(403).json({
        error: "你没有权限进入该频道",
      });
    }

    let capacity;
    try {
      capacity = await assertChannelCapacity({ roomService, channel });
    } catch (error) {
      console.error("Check channel capacity error:", error);
      return res.status(503).json({
        error: "暂时无法确认频道人数，请稍后再试",
      });
    }

    if (!capacity.allowed) {
      return res.status(capacity.status).json({
        error: capacity.error,
      });
    }

    const participantIdentity = getVoiceParticipantIdentity(user, req.query.voiceConnectionId);
    const serverMute = voiceManagement.getTokenServerMute(participantIdentity, channel.id);

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: participantIdentity,
        name: user.displayName,
        metadata: JSON.stringify({
          displayName: user.displayName,
          role: user.role,
          isGuest: user.isGuest,
          positions: user.positions || [],
          positionNames: user.positionNames || [],
          serverMuted: serverMute.serverMuted,
        }),
      }
    );

    at.addGrant({
      room: channel.id,
      roomJoin: true,
      canPublish: !serverMute.serverMuted,
      canSubscribe: true,
      canPublishData: true,
      ...(serverMute.serverMuted ? { canPublishSources: [] } : {}),
    });

    const token = await at.toJwt();

    res.json({
      token,
      url: process.env.LIVEKIT_URL,
      serverMuted: serverMute.serverMuted,
      participantIdentity,
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
          role,
          avatar_path
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
            avatarUrl: publicUser.avatarUrl,
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
  requireAdmin,
  (req, res) => {
    try {
      const members = db.prepare(`
        SELECT
          id,
          username,
          display_name,
          role,
          avatar_path,
          created_at
        FROM users
        ORDER BY
          CASE
            WHEN role = 'admin' THEN 0
            ELSE 1
          END,
          created_at ASC
      `).all();

      res.json({
        members: members.map(toManagedMember),
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
  requireAdmin,
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

      const nicknameResult =
        normalizeAccountNickname(rawNickname);

      if (nicknameResult.error) {
        return res.status(400).json({
          error: nicknameResult.error,
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
        password.length < 8 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error:
            "初始密码必须为 8—128 位",
        });
      }

      const nickname = nicknameResult.nickname;
      const usernameKey = nicknameResult.nicknameKey;

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

      const createMember = db.transaction(() => {
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

        db.prepare(`
          INSERT INTO user_positions (user_id, position)
          VALUES (?, ?)
        `).run(newUser.id, newUser.position);

        return getAccountUser(newUser.id);
      });

      const createdUser = createMember();

      res.status(201).json({
        success: true,
        member: toManagedMember(createdUser),
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

app.patch("/api/admin/members/:memberId",
  requireAdmin,
  (req, res) => {
    try {
      const member = getAccountUser(req.params.memberId);

      if (!member) {
        return res.status(404).json({
          error: "正式成员不存在",
        });
      }

      const nicknameResult = normalizeAccountNickname(
        req.body?.nickname
      );

      if (nicknameResult.error) {
        return res.status(400).json({
          error: nicknameResult.error,
        });
      }

      const duplicateUser = db.prepare(`
        SELECT id
        FROM users
        WHERE username_key = ? AND id <> ?
      `).get(nicknameResult.nicknameKey, member.id);

      if (duplicateUser) {
        return res.status(409).json({
          error: "该昵称已被其他正式成员使用",
        });
      }

      const updateMember = db.transaction(() => {
        db.prepare(`
          UPDATE users
          SET username = ?, username_key = ?, display_name = ?
          WHERE id = ?
        `).run(
          nicknameResult.nickname,
          nicknameResult.nicknameKey,
          nicknameResult.nickname,
          member.id
        );

        return getAccountUser(member.id);
      });

      res.json({
        success: true,
        member: toManagedMember(updateMember()),
      });
    } catch (error) {
      console.error("Admin update member error:", error);

      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({
          error: "该昵称已被其他正式成员使用",
        });
      }

      res.status(500).json({
        error: "修改成员昵称失败",
      });
    }
  }
);

app.put("/api/admin/members/:memberId/positions",
  requireAdmin,
  (req, res) => {
    try {
      const member = getAccountUser(req.params.memberId);

      if (!member) {
        return res.status(404).json({
          error: "正式成员不存在",
        });
      }

      const requestedPositions = req.body?.positions;

      if (!Array.isArray(requestedPositions)) {
        return res.status(400).json({
          error: "职位必须使用数组提交",
        });
      }

      if (requestedPositions.some(
        (position) => typeof position !== "string"
      )) {
        return res.status(400).json({
          error: "职位格式不正确",
        });
      }

      const positions = [...new Set(requestedPositions)];

      if (positions.length === 0) {
        return res.status(400).json({
          error: "至少需要保留一个职位",
        });
      }

      if (positions.some(
        (position) => !ACCOUNT_POSITIONS.has(position)
      )) {
        return res.status(400).json({
          error: "包含未知的战队职位",
        });
      }

      const updatePositions = db.transaction(() => {
        db.prepare(`
          DELETE FROM user_positions WHERE user_id = ?
        `).run(member.id);

        const insertPosition = db.prepare(`
          INSERT INTO user_positions (user_id, position)
          VALUES (?, ?)
        `);

        for (const position of positions) {
          insertPosition.run(member.id, position);
        }

        return getAccountUser(member.id);
      });

      res.json({
        success: true,
        member: toManagedMember(updatePositions()),
      });
    } catch (error) {
      console.error("Admin update member positions error:", error);
      res.status(500).json({
        error: "修改成员职位失败",
      });
    }
  }
);

app.post("/api/admin/members/:memberId/reset-password",
  requireAdmin,
  async (req, res) => {
    try {
      const member = getAccountUser(req.params.memberId);

      if (!member) {
        return res.status(404).json({
          error: "正式成员不存在",
        });
      }

      if (member.id === req.authUser.id) {
        return res.status(400).json({
          error: "请在“我的账号”中修改自己的密码",
        });
      }

      const newPassword = req.body?.newPassword;
      const confirmPassword = req.body?.confirmPassword;

      if (
        typeof newPassword !== "string" ||
        typeof confirmPassword !== "string"
      ) {
        return res.status(400).json({
          error: "请完整填写新密码",
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

      const passwordHash = await hashPassword(newPassword);
      const resetPassword = db.transaction(() => {
        db.prepare(`
          UPDATE users SET password_hash = ? WHERE id = ?
        `).run(passwordHash, member.id);
        db.prepare(`
          DELETE FROM sessions WHERE user_id = ?
        `).run(member.id);
      });

      resetPassword();

      res.json({
        success: true,
        message: "密码已重置，目标成员的现有登录会话已失效",
      });
    } catch (error) {
      console.error("Admin reset member password error:", error);
      res.status(500).json({
        error: "重置成员密码失败",
      });
    }
  }
);

app.delete("/api/admin/members/:memberId",
  requireAdmin,
  (req, res) => {
    try {
      const member = getAccountUser(req.params.memberId);

      if (!member) {
        return res.status(404).json({
          error: "正式成员不存在",
        });
      }

      if (member.id === req.authUser.id) {
        return res.status(400).json({
          error: "不能删除当前正在操作的管理员账号",
        });
      }

      if (member.role === "admin") {
        const adminCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM users
          WHERE role = 'admin'
        `).get().count;

        if (adminCount <= 1) {
          return res.status(409).json({
            error: "系统必须至少保留一个管理员",
          });
        }
      }

      const deleteMember = db.transaction(() => {
        db.prepare(`
          DELETE FROM sessions WHERE user_id = ?
        `).run(member.id);
        db.prepare(`
          DELETE FROM user_positions WHERE user_id = ?
        `).run(member.id);
        db.prepare(`
          DELETE FROM users WHERE id = ?
        `).run(member.id);
      });

      deleteMember();

      res.json({
        success: true,
        message: `成员 ${member.display_name || member.username} 已删除`,
      });
    } catch (error) {
      console.error("Admin delete member error:", error);
      res.status(500).json({
        error: "删除成员失败",
      });
    }
  }
);


function sendVoiceManagementResult(res, result, successMessage) {
  if (result.error) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  return res.json({
    success: true,
    ok: true,
    message: successMessage(result),
    serverMuted: result.serverMuted,
    participantName: result.participantName,
    targetChannelName: result.targetChannelName,
    idempotent: Boolean(result.idempotent),
    alreadyMuted: Boolean(result.alreadyMuted),
  });
}

app.post("/api/voice/participants/mute", requireAuthenticated, async (req, res) => {
  try {
    const result = await voiceManagement.mute({ actor: req.authUser, sourceChannelId: req.body?.sourceChannelId, participantIdentity: req.body?.participantIdentity });
    return sendVoiceManagementResult(res, result, (value) => value.idempotent ? `“${value.participantName}”已处于服务器静音状态` : `已服务器静音“${value.participantName}”`);
  } catch (error) {
    console.error("Voice mute error:", error?.message || error);
    return res.status(502).json({ error: "服务器静音失败" });
  }
});

app.post("/api/voice/participants/unmute", requireAuthenticated, async (req, res) => {
  try {
    const result = await voiceManagement.unmute({ actor: req.authUser, sourceChannelId: req.body?.sourceChannelId, participantIdentity: req.body?.participantIdentity });
    return sendVoiceManagementResult(res, result, (value) => value.idempotent ? `“${value.participantName}”未处于服务器静音状态` : `已解除“${value.participantName}”的服务器静音`);
  } catch (error) {
    console.error("Voice unmute error:", error?.message || error);
    return res.status(502).json({ error: "解除服务器静音失败" });
  }
});

app.post("/api/voice/participants/remove", requireAuthenticated, async (req, res) => {
  try {
    const result = await voiceManagement.remove({ actor: req.authUser, sourceChannelId: req.body?.sourceChannelId, participantIdentity: req.body?.participantIdentity });
    return sendVoiceManagementResult(res, result, (value) => `已将“${value.participantName}”移出频道`);
  } catch (error) {
    console.error("Voice remove error:", error?.message || error);
    return res.status(502).json({ error: "移出频道失败" });
  }
});

app.post("/api/voice/participants/move", requireAuthenticated, async (req, res) => {
  try {
    const result = await voiceManagement.move({ actor: req.authUser, sourceChannelId: req.body?.sourceChannelId, participantIdentity: req.body?.participantIdentity, targetChannelId: req.body?.targetChannelId });
    return sendVoiceManagementResult(res, result, (value) => `已将“${value.participantName}”移动到“${value.targetChannelName}”`);
  } catch (error) {
    console.error("Voice move error:", error?.message || error);
    return res.status(502).json({ error: "移动频道失败" });
  }
});

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


const server = createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!presence.handleUpgrade(req, socket, head)) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  }
});

server.listen(process.env.PORT || 3001, () => {
  console.log(`Server running on port ${process.env.PORT || 3001}`);
});

// 供后端测试直接访问真实路由（生产行为不变）
export { app, server };
