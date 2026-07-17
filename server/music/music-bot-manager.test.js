import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { migrateMusicQueue } from "./queue-migrate.js";
import { enqueueTracks } from "./music-queue.js";
import {
  classifyPlaybackError,
  createMusicBotManager,
} from "./music-bot-manager.js";

// 全部依赖注入 mock：不触碰真实 FFmpeg / LiveKit / 网易云 / 网络 / 生产库

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.prepare("INSERT INTO channels VALUES ('cs2', 'CS2')").run();
  db.prepare("INSERT INTO channels VALUES ('apex', 'Apex')").run();
  migrateMusicQueue(db);
  return db;
}

let songSeq = 1;
function enqueue(db, principalKey, count, channelId = "cs2") {
  const tracks = Array.from({ length: count }, () => {
    const id = String(songSeq++);
    return {
      id,
      name: `歌-${principalKey}-${id}`,
      artists: [],
      album: null,
      durationMs: 1000,
      fee: 0,
    };
  });
  return enqueueTracks(db, {
    channelId,
    principalKey,
    requesterDisplayName: `名-${principalKey}`,
    tracks,
  });
}

function statusOf(db, songName) {
  return db
    .prepare("SELECT status FROM music_queue_items WHERE song_name = ?")
    .get(songName)?.status;
}

// 可控 mock：记录播放顺序、按需注入错误
function makeDeps(overrides = {}) {
  const played = [];
  const logs = [];
  const deps = {
    presenceService: {
      hasUsersInChannel: overrides.hasUsers ?? (() => true),
    },
    ffmpegRuntime: {
      probeFfmpeg:
        overrides.probeFfmpeg ?? (async () => ({ ffmpegPath: "/fake/ffmpeg" })),
      clearProbeCache: () => {},
    },
    loadCredential:
      overrides.loadCredential ??
      (() => ({ cookie: "MUSIC_U=fake", neteaseUserId: "1" })),
    neteaseClient: {
      getSongPlaybackUrl:
        overrides.getSongPlaybackUrl ??
        (async () => ({ url: "https://m701.music.126.net/x.mp3" })),
    },
    createAudioSession:
      overrides.createAudioSession ??
      (async () => ({
        identity: "music-bot:cs2",
        captureFrame: async () => {},
        waitForPlayout: async () => {},
        close: async () => {},
      })),
    openMediaStream:
      overrides.openMediaStream ??
      (async () => Readable.from([Buffer.alloc(4)])),
    createByteLimit: overrides.createByteLimit ?? (() => null),
    decodeToFrames:
      overrides.decodeToFrames ??
      (async ({ onFrame }) => {
        await onFrame(new Int16Array(480));
        return { framesDelivered: 1 };
      }),
    logger: {
      error: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg),
    },
    scanIntervalMs: 60_000,
    backoffInitialMs: 10,
    backoffMaxMs: 40,
  };
  return { deps, played, logs };
}

// 追踪播放顺序的成功解码器
function trackingDecoder(played) {
  return async ({ onFrame }) => {
    await onFrame(new Int16Array(480));
    return { framesDelivered: 1 };
  };
}

// 等待 manager 的所有 worker 完成（activeChannelCount 归零）
async function drain(manager, maxMs = 2000) {
  const start = Date.now();
  while (manager.activeChannelCount > 0 && Date.now() - start < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------- 错误分类 ----------

test("classifyPlaybackError：基础设施 / 跳过 / 失败", () => {
  assert.equal(classifyPlaybackError({ code: "FFMPEG_NOT_AVAILABLE" }), "requeue");
  assert.equal(classifyPlaybackError({ code: "MEDIA_STALL_TIMEOUT" }), "requeue");
  assert.equal(classifyPlaybackError({ code: "MEDIA_STREAM_INTERRUPTED" }), "fail");
  assert.equal(classifyPlaybackError({ code: "MEDIA_RANGE_UNSUPPORTED" }), "fail");
  assert.equal(classifyPlaybackError({ code: "MEDIA_RANGE_MISMATCH" }), "fail");
  assert.equal(classifyPlaybackError({ code: "NETEASE_PLAYBACK_RATE_LIMITED" }), "requeue");
  assert.equal(classifyPlaybackError({ code: "MUSIC_BOT_CONNECT_FAILED" }), "requeue");
  assert.equal(classifyPlaybackError({ code: "NETEASE_PLAYBACK_TRIAL_ONLY" }), "skip");
  assert.equal(classifyPlaybackError({ code: "NETEASE_ACCOUNT_NOT_BOUND" }), "skip");
  assert.equal(classifyPlaybackError({ code: "FFMPEG_DECODE_FAILED" }), "fail");
  assert.equal(classifyPlaybackError({ code: "MEDIA_TOO_LARGE" }), "fail");
  assert.equal(classifyPlaybackError({ code: "WHATEVER_UNKNOWN" }), "fail");
});

// ---------- 基本行为 ----------

test("无稳定听众时不 claim", async () => {
  const db = createDb();
  enqueue(db, "user-a", 2);
  const { deps } = makeDeps({ hasUsers: () => false });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  assert.equal(statusOf(db, "歌-user-a-1"), "pending");
  db.close();
});

test("同频道只有一个 worker", async () => {
  const db = createDb();
  enqueue(db, "user-a", 3);
  let concurrent = 0;
  let maxConcurrent = 0;
  const { deps } = makeDeps({
    decodeToFrames: async ({ onFrame }) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      await onFrame(new Int16Array(480));
      concurrent -= 1;
      return { framesDelivered: 1 };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  manager.kick("cs2");
  manager.kick("cs2");
  await drain(manager);
  assert.equal(maxConcurrent, 1);
  db.close();
});

test("不同频道独立播放", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1, "cs2");
  enqueue(db, "user-b", 1, "apex");
  const channelsSeen = new Set();
  const { deps } = makeDeps({
    createAudioSession: async ({ channelId }) => {
      channelsSeen.add(channelId);
      return {
        identity: `music-bot:${channelId}`,
        captureFrame: async () => {},
        waitForPlayout: async () => {},
        close: async () => {},
      };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  manager.kick("apex");
  await drain(manager);
  assert.deepEqual([...channelsSeen].sort(), ["apex", "cs2"]);
  db.close();
});

test("正常播放全部 finished，队列空后机器人离开", async () => {
  const db = createDb();
  enqueue(db, "user-a", 3);
  let closed = 0;
  const { deps } = makeDeps({
    createAudioSession: async () => ({
      identity: "music-bot:cs2",
      captureFrame: async () => {},
      waitForPlayout: async () => {},
      close: async () => {
        closed += 1;
      },
    }),
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);

  const statuses = db
    .prepare("SELECT status FROM music_queue_items")
    .all()
    .map((row) => row.status);
  assert.deepEqual(statuses, ["finished", "finished", "finished"]);
  assert.equal(closed, 1); // 会话复用后只关一次
  assert.equal(manager.activeChannelCount, 0);
  db.close();
});

test("A1→B1→A2→B2 公平消费顺序", async () => {
  const db = createDb();
  // A 先加 3 首，B 加 2 首
  const aIds = [];
  const bIds = [];
  for (let i = 0; i < 3; i += 1) {
    const r = enqueue(db, "user-a", 1);
    aIds.push(`歌-user-a-${songSeq - 1}`);
  }
  for (let i = 0; i < 2; i += 1) {
    enqueue(db, "user-b", 1);
    bIds.push(`歌-user-b-${songSeq - 1}`);
  }
  const order = [];
  const { deps } = makeDeps({
    getSongPlaybackUrl: async ({ songId }) => {
      const row = db
        .prepare("SELECT song_name FROM music_queue_items WHERE song_id = ?")
        .get(songId);
      order.push(row.song_name);
      return { url: "https://m701.music.126.net/x.mp3" };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  // 交替：A B A B A
  assert.equal(order.length, 5);
  assert.equal(order[0], aIds[0]);
  assert.equal(order[1], bIds[0]);
  assert.equal(order[2], aIds[1]);
  assert.equal(order[3], bIds[1]);
  assert.equal(order[4], aIds[2]);
  db.close();
});

// ---------- 错误处理 ----------

test("无权限歌曲 skipped，不影响后续", async () => {
  const db = createDb();
  enqueue(db, "user-a", 2);
  let call = 0;
  const { deps } = makeDeps({
    getSongPlaybackUrl: async () => {
      call += 1;
      if (call === 1) {
        const error = new Error("no permission");
        error.code = "NETEASE_PLAYBACK_URL_UNAVAILABLE";
        throw error;
      }
      return { url: "https://m701.music.126.net/x.mp3" };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  const statuses = db
    .prepare("SELECT status, failure_code FROM music_queue_items ORDER BY id")
    .all();
  assert.equal(statuses[0].status, "skipped");
  assert.equal(statuses[0].failure_code, "NETEASE_PLAYBACK_URL_UNAVAILABLE");
  assert.equal(statuses[1].status, "finished");
  db.close();
});

test("解码损坏 failed", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const { deps } = makeDeps({
    decodeToFrames: async () => {
      const error = new Error("bad data");
      error.code = "FFMPEG_DECODE_FAILED";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  assert.equal(statusOf(db, "歌-user-a-" + (songSeq - 1)), "failed");
  db.close();
});

test("FFmpeg 不可用 → requeue，保持 pending，不领取后续", async () => {
  const db = createDb();
  enqueue(db, "user-a", 2);
  let probeCount = 0;
  const { deps } = makeDeps({
    probeFfmpeg: async () => {
      probeCount += 1;
      const error = new Error("no ffmpeg");
      error.code = "FFMPEG_NOT_AVAILABLE";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  // 探测失败 → 退避；给一点时间后停止
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.stop();
  // 队列全部保持 pending（一首都没 claim）
  const statuses = db
    .prepare("SELECT DISTINCT status FROM music_queue_items")
    .all()
    .map((row) => row.status);
  assert.deepEqual(statuses, ["pending"]);
  assert.ok(probeCount >= 1);
  db.close();
});

test("CDN 超时 → requeue 且恢复公平游标（A1 仍是 A1）", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  enqueue(db, "user-b", 1);
  const firstSong = "歌-user-a-" + (songSeq - 2);
  let mediaCall = 0;
  const order = [];
  const { deps } = makeDeps({
    getSongPlaybackUrl: async ({ songId }) => {
      const row = db
        .prepare("SELECT song_name FROM music_queue_items WHERE song_id = ?")
        .get(songId);
      order.push(row.song_name);
      return { url: "https://m701.music.126.net/x.mp3" };
    },
    openMediaStream: async () => {
      mediaCall += 1;
      if (mediaCall === 1) {
        const error = new Error("stall");
        error.code = "MEDIA_STALL_TIMEOUT";
        throw error;
      }
      return Readable.from([Buffer.alloc(4)]);
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager, 3000);
  // A1 第一次失败被 requeue，重试时仍是 A1（不跳到 B1）
  assert.equal(order[0], firstSong);
  assert.equal(order[1], firstSong);
  db.close();
});

test("分块重试耗尽后不从头重播，重建会话并继续 B1", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  enqueue(db, "user-b", 1);
  const firstSong = "歌-user-a-" + (songSeq - 2);
  const playbackOrder = [];
  const closedSessions = [];
  let sessionCount = 0;
  let decodeCount = 0;
  const { deps, logs } = makeDeps({
    getSongPlaybackUrl: async ({ songId }) => {
      const row = db
        .prepare("SELECT song_name FROM music_queue_items WHERE song_id = ?")
        .get(songId);
      playbackOrder.push(row.song_name);
      return { url: "https://m701.music.126.net/private.mp3?token=secret" };
    },
    createAudioSession: async () => {
      sessionCount += 1;
      const id = sessionCount;
      return {
        captureFrame: async () => {},
        waitForPlayout: async () => {},
        close: async () => closedSessions.push(id),
      };
    },
    decodeToFrames: async ({ onFrame }) => {
      decodeCount += 1;
      if (decodeCount === 1) {
        const error = new Error("must not be logged: token=secret");
        error.code = "MEDIA_STREAM_INTERRUPTED";
        error.diagnostics = {
          hostname: "m701.music.126.net",
          attemptCount: 3,
          blockStart: 1048576,
          bytesTransferred: 8192,
          causeCodeChain: ["MEDIA_FETCH_FAILED", "UND_ERR_SOCKET"],
        };
        throw error;
      }
      await onFrame(new Int16Array(480));
      return { framesDelivered: 1 };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager, 3000);

  assert.equal(playbackOrder[0], firstSong);
  assert.notEqual(playbackOrder[1], firstSong);
  assert.equal(playbackOrder.length, 2);
  assert.equal(sessionCount, 2);
  assert.deepEqual(closedSessions, [1, 2]);
  assert.deepEqual(
    db
      .prepare("SELECT status, failure_code FROM music_queue_items ORDER BY id")
      .all(),
    [
      { status: "failed", failure_code: "MEDIA_STREAM_INTERRUPTED" },
      { status: "finished", failure_code: null },
    ]
  );
  const dump = logs.join("\n");
  assert.match(dump, /MEDIA_STREAM_INTERRUPTED/);
  assert.match(dump, /host=m701\.music\.126\.net/);
  assert.equal(dump.includes("private.mp3"), false);
  assert.equal(dump.includes("token=secret"), false);
  assert.equal(dump.includes("MUSIC_U"), false);
  db.close();
});

test("LiveKit 会话失败 → requeue，pending 保留", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  let attempts = 0;
  const { deps } = makeDeps({
    createAudioSession: async () => {
      attempts += 1;
      const error = new Error("connect refused");
      error.code = "MUSIC_BOT_CONNECT_FAILED";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await manager.stop();
  assert.ok(attempts >= 1);
  // 歌曲回到 pending（Abort 时 requeue 或错误 requeue）
  assert.equal(statusOf(db, "歌-user-a-" + (songSeq - 1)), "pending");
  db.close();
});

test("stop/Abort：正在播放的歌曲恢复 pending", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const songName = "歌-user-a-" + (songSeq - 1);
  const { deps } = makeDeps({
    decodeToFrames: async ({ signal }) => {
      // 模拟长歌曲：等待 abort
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      const error = new Error("aborted");
      error.code = "FFMPEG_ABORTED";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // 播放中
  assert.equal(statusOf(db, songName), "playing");
  await manager.stop();
  // Abort → FFMPEG_ABORTED → requeue → pending
  assert.equal(statusOf(db, songName), "pending");
  db.close();
});

test("成功一首后清除退避（连续两首快速播放）", async () => {
  const db = createDb();
  enqueue(db, "user-a", 2);
  const timestamps = [];
  const { deps } = makeDeps({
    decodeToFrames: async ({ onFrame }) => {
      timestamps.push(Date.now());
      await onFrame(new Int16Array(480));
      return { framesDelivered: 1 };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  assert.equal(timestamps.length, 2);
  // 两首之间无退避延迟（间隔远小于 backoffInitial 10ms 的多倍）
  assert.ok(timestamps[1] - timestamps[0] < 100);
  db.close();
});

test("scan 恢复重启前的 pending（有听众时自动 kick）", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const { deps } = makeDeps();
  const manager = createMusicBotManager({ db, ...deps });
  manager.scan();
  await drain(manager);
  assert.equal(statusOf(db, "歌-user-a-" + (songSeq - 1)), "finished");
  db.close();
});

test("日志不含 Cookie / URL / principal_key", async () => {
  const db = createDb();
  enqueue(db, "secret-principal", 1);
  const { deps, logs } = makeDeps({
    getSongPlaybackUrl: async () => {
      const error = new Error("boom");
      error.code = "FFMPEG_DECODE_FAILED";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager);
  const dump = logs.join("\n");
  assert.ok(!dump.includes("MUSIC_U"));
  assert.ok(!dump.includes("music.126.net"));
  assert.ok(!dump.includes("secret-principal"));
  db.close();
});

test("worker 顶层不产生 unhandledRejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const db = createDb();
    enqueue(db, "user-a", 1);
    const { deps } = makeDeps({
      // 抛非 Error 值
      decodeToFrames: async () => {
        throw "raw-string-error";
      },
    });
    const manager = createMusicBotManager({ db, ...deps });
    manager.kick("cs2");
    await drain(manager);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
    db.close();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("FFMPEG_PATH_INVALID 归类为基础设施错误（requeue）", () => {
  assert.equal(classifyPlaybackError({ code: "FFMPEG_PATH_INVALID" }), "requeue");
});

test("FFmpeg 配置错误：播放中歌曲恢复 pending、公平游标恢复、进入退避", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  enqueue(db, "user-b", 1);
  const firstSong = "歌-user-a-" + (songSeq - 2);
  let attempts = 0;
  const { deps, logs } = makeDeps({
    // 探测通过（缓存的旧结果），解码时二进制被移走 → 配置类错误
    decodeToFrames: async () => {
      attempts += 1;
      const error = new Error("binary vanished");
      error.code = attempts === 1 ? "FFMPEG_PATH_INVALID" : "FFMPEG_NOT_AVAILABLE";
      throw error;
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  // 第一次失败 requeue 后进入退避（10ms 起）；等待第二次尝试开始
  await new Promise((resolve) => setTimeout(resolve, 25));
  await manager.stop();

  // 游标恢复：仍轮到 A（第二次尝试的也是 A1，而不是 B1）
  const rows = db
    .prepare("SELECT song_name, status FROM music_queue_items ORDER BY id")
    .all();
  // 两首都保持 pending（没有被吞、没有 failed）
  assert.ok(rows.every((row) => row.status === "pending"), JSON.stringify(rows));
  // 游标已恢复为 claim 之前的值 → 下一次 claim 仍是 A1
  const { claimNextQueueItem } = await import("./music-queue.js");
  const retry = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(retry.queueItem.song_name, firstSong);

  // 至少经历一次失败与退避；日志只含稳定错误码，不含路径/Cookie
  assert.ok(attempts >= 1);
  const dump = logs.join("\n");
  assert.ok(!dump.includes("/custom"));
  assert.ok(!dump.includes("MUSIC_U"));
  assert.ok(dump.includes("FFMPEG_PATH_INVALID") || dump.includes("FFMPEG_NOT_AVAILABLE"));
  db.close();
});
