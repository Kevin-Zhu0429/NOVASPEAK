// 一次性音乐机器人推流验证 CLI（6A 阶段）。
//
// 用法（在 server 目录）：
//   npm run music-bot:probe -- --list-channels
//   npm run music-bot:probe -- --channel-id <频道ID> --duration 5
//
// 只读取 SQLite channels 表验证频道存在；不启动 Express，
// 不修改频道 / 用户 / 网易云数据，不接受远程音频 URL 或任意文件。
// 禁止输出 token、API secret 和完整环境变量。

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  MusicBotError,
  playTestToneInChannel,
} from "../music/livekit-bot.js";
import { parseDurationSeconds } from "../music/test-tone.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databasePath = process.env.NOVASPEAK_DB_PATH
  ? path.resolve(process.env.NOVASPEAK_DB_PATH)
  : path.join(__dirname, "..", "data", "novaspeak.db");

const STATUS_MESSAGES = {
  connecting: "正在连接 LiveKit……",
  connected: "已加入频道",
  published: "已发布测试音轨，开始推送测试音",
  completed: "测试完成",
  aborted: "收到停止信号，已提前结束",
  disconnected: "已断开",
};

function parseArgs(argv) {
  const args = { listChannels: false, channelId: null, duration: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list-channels") {
      args.listChannels = true;
    } else if (arg === "--channel-id") {
      args.channelId = argv[i + 1];
      i += 1;
    } else if (arg === "--duration") {
      args.duration = argv[i + 1];
      i += 1;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return { args };
}

function openChannelsDatabase() {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

function listChannels() {
  const db = openChannelsDatabase();
  try {
    const channels = db
      .prepare("SELECT id, name FROM channels ORDER BY name")
      .all();
    if (channels.length === 0) {
      console.log("没有可用频道");
      return;
    }
    console.log("可用语音频道（channelId  名称）：");
    for (const channel of channels) {
      console.log(`${channel.id}  ${channel.name}`);
    }
  } finally {
    db.close();
  }
}

function assertChannelExists(channelId) {
  const db = openChannelsDatabase();
  try {
    return db
      .prepare("SELECT id, name FROM channels WHERE id = ?")
      .get(channelId);
  } finally {
    db.close();
  }
}

async function disposeRtcIfLoaded() {
  // 全局 dispose() 只属于本一次性 CLI：进程即将退出，
  // 释放原生 RTC 资源，避免进程悬挂
  try {
    const rtc = await import("@livekit/rtc-node");
    await rtc.dispose();
  } catch {
    // RTC 模块从未成功加载时无需释放
  }
}

async function runProbe(channelId, durationRaw) {
  const parsedDuration = parseDurationSeconds(durationRaw);
  if (!parsedDuration.ok) {
    console.error(parsedDuration.error);
    process.exitCode = 1;
    return;
  }

  const channel = assertChannelExists(channelId);
  if (!channel) {
    console.error(`频道不存在：${channelId}`);
    console.error("可先运行 --list-channels 查看可用频道");
    process.exitCode = 1;
    return;
  }

  console.log(
    `目标频道：${channel.name}（${channel.id}），时长 ${parsedDuration.seconds} 秒`
  );

  const abortController = new AbortController();
  const stop = () => {
    console.log("正在停止……");
    abortController.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const result = await playTestToneInChannel({
      channelId: channel.id,
      durationSeconds: parsedDuration.seconds,
      signal: abortController.signal,
      onStatus: (status) => {
        const message = STATUS_MESSAGES[status];
        if (message) console.log(message);
      },
    });
    console.log(
      `机器人 ${result.identity} 共推送 ${result.framesSent}/${result.totalFrames} 帧`
    );
  } catch (error) {
    if (error instanceof MusicBotError) {
      console.error(`失败（${error.code}）：${error.message}`);
    } else {
      console.error(`失败：${error?.message || "未知错误"}`);
    }
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await disposeRtcIfLoaded();
  }
}

const { args, error } = parseArgs(process.argv.slice(2));

if (error) {
  console.error(error);
  console.error(
    "用法：--list-channels 或 --channel-id <频道ID> [--duration 1~30]"
  );
  process.exitCode = 1;
} else if (args.listChannels) {
  listChannels();
} else if (args.channelId) {
  await runProbe(args.channelId, args.duration);
} else {
  console.error(
    "用法：--list-channels 或 --channel-id <频道ID> [--duration 1~30]"
  );
  process.exitCode = 1;
}
