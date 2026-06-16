import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import db from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const clientDistPath = path.resolve(
  __dirname,
  "../client/dist"
);

const app = express();

app.use(cors());
app.use(express.json());

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