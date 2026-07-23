import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { migrateMusicQueue } from "./queue-migrate.js";
import {
  cancelQueueItem,
  clearPendingQueue,
  enqueueTracks,
  prioritizeQueueItem,
  setDjTransitionEnabled,
  shufflePendingQueue,
} from "./music-queue.js";
import {
  DJ_TRANSITION_DEFAULTS,
  classifyPlaybackError,
  createMusicBotManager,
} from "./music-bot-manager.js";
import { equalPowerGains } from "./crossfade-mixer.js";

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
        await onFrame(new Int16Array(960));
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
    await onFrame(new Int16Array(960));
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
  assert.equal(classifyPlaybackError({ code: "MUSIC_BOT_DISCONNECTED" }), "requeue");
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
      await onFrame(new Int16Array(960));
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

test("暂停冻结 PCM 推送与共享进度，继续后从原位置完成", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const songName = `歌-user-a-${songSeq - 1}`;
  let clock = 1_000;
  let captured = 0;
  let resolveFirstFrame;
  let releaseSecondFrame;
  const firstFrame = new Promise((resolve) => { resolveFirstFrame = resolve; });
  const secondFrame = new Promise((resolve) => { releaseSecondFrame = resolve; });
  const { deps } = makeDeps({
    createAudioSession: async () => ({
      identity: "music-bot:cs2",
      captureFrame: async () => { captured += 1; },
      waitForPlayout: async () => {},
      close: async () => {},
    }),
    decodeToFrames: async ({ onFrame }) => {
      await onFrame(new Int16Array(960));
      resolveFirstFrame();
      await secondFrame;
      await onFrame(new Int16Array(960));
      return { framesDelivered: 2 };
    },
  });
  const manager = createMusicBotManager({ db, ...deps, now: () => clock });
  manager.kick("cs2");
  await firstFrame;

  clock = 1_500;
  const paused = manager.setPaused("cs2", true);
  assert.equal(paused.changed, true);
  assert.equal(paused.paused, true);
  assert.equal(paused.elapsedMs, 500);
  releaseSecondFrame();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(captured, 1);

  clock = 8_000;
  assert.equal(manager.getPlaybackState("cs2").elapsedMs, 500);
  const resumed = manager.setPaused("cs2", false);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.elapsedMs, 500);
  await drain(manager);
  assert.equal(captured, 2);
  assert.equal(statusOf(db, songName), "finished");
  db.close();
});

test("下一首跳过当前项并继续公平顺序，不恢复或吞掉后续歌曲", async () => {
  const db = createDb();
  enqueue(db, "user-a", 2);
  enqueue(db, "user-b", 1);
  const rowsBefore = db
    .prepare("SELECT id, song_name FROM music_queue_items ORDER BY id")
    .all();
  const order = [];
  let decodeCalls = 0;
  const { deps } = makeDeps({
    getSongPlaybackUrl: async ({ songId }) => {
      order.push(
        db.prepare("SELECT song_name FROM music_queue_items WHERE song_id = ?").get(songId).song_name
      );
      return { url: "https://m701.music.126.net/x.mp3" };
    },
    decodeToFrames: async ({ onFrame, signal }) => {
      decodeCalls += 1;
      if (decodeCalls === 1) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        const error = new Error("skipped");
        error.code = "FFMPEG_ABORTED";
        throw error;
      }
      await onFrame(new Int16Array(960));
      return { framesDelivered: 1 };
    },
  });
  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  while (!manager.getPlaybackState("cs2").active) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const skipped = await manager.skip("cs2");
  assert.equal(skipped.changed, true);
  await drain(manager);

  const statuses = db
    .prepare("SELECT song_name, status FROM music_queue_items ORDER BY id")
    .all();
  assert.deepEqual(statuses, [
    { song_name: rowsBefore[0].song_name, status: "skipped" },
    { song_name: rowsBefore[1].song_name, status: "finished" },
    { song_name: rowsBefore[2].song_name, status: "finished" },
  ]);
  assert.deepEqual(order, [
    rowsBefore[0].song_name,
    rowsBefore[2].song_name,
    rowsBefore[1].song_name,
  ]);
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
      await onFrame(new Int16Array(960));
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

test("机器人被移出频道后：当前歌曲回到原位并用新会话自动重连", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const songName = "歌-user-a-" + (songSeq - 1);
  let sessionCount = 0;
  let decodeCount = 0;
  const closedSessions = [];
  let disconnectFirstSession = null;
  const { deps } = makeDeps({
    createAudioSession: async ({ onUnexpectedDisconnect }) => {
      sessionCount += 1;
      const sessionId = sessionCount;
      if (sessionId === 1) disconnectFirstSession = onUnexpectedDisconnect;
      return {
        identity: "music-bot:cs2",
        captureFrame: async () => {},
        waitForPlayout: async () => {},
        close: async () => closedSessions.push(sessionId),
      };
    },
    decodeToFrames: async ({ onFrame, signal }) => {
      decodeCount += 1;
      if (decodeCount === 1) {
        disconnectFirstSession();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(signal.aborted, true);
        const error = new Error("room disconnected");
        error.code = "FFMPEG_ABORTED";
        throw error;
      }
      await onFrame(new Int16Array(960));
      return { framesDelivered: 1 };
    },
  });

  const manager = createMusicBotManager({ db, ...deps });
  manager.kick("cs2");
  await drain(manager, 3000);

  assert.equal(sessionCount, 2);
  assert.deepEqual(closedSessions, [1, 2]);
  assert.equal(statusOf(db, songName), "finished");
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
      await onFrame(new Int16Array(960));
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

test("频道持续无人两分钟后暂停并把当前歌曲放回原公平位置", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const songName = `歌-user-a-${songSeq - 1}`;
  let usersPresent = true;
  let clock = 0;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const { deps } = makeDeps({
    hasUsers: () => usersPresent,
    decodeToFrames: async ({ onFrame, signal }) => {
      await onFrame(new Int16Array(960));
      resolveStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("idle abort");
      error.code = "FFMPEG_ABORTED";
      throw error;
    },
  });
  const manager = createMusicBotManager({
    db,
    ...deps,
    idlePauseMs: 120_000,
    now: () => clock,
  });
  manager.kick("cs2");
  await started;
  assert.equal(statusOf(db, songName), "playing");

  usersPresent = false;
  manager.scan();
  clock = 119_999;
  manager.scan();
  assert.equal(statusOf(db, songName), "playing");

  clock = 120_000;
  manager.scan();
  await drain(manager);
  assert.equal(statusOf(db, songName), "pending");
  assert.equal(manager.activeChannelCount, 0);
  db.close();
});

test("成员在空置期限内返回会取消暂停倒计时", async () => {
  const db = createDb();
  enqueue(db, "user-a", 1);
  const songName = `歌-user-a-${songSeq - 1}`;
  let usersPresent = true;
  let clock = 0;
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const { deps } = makeDeps({
    hasUsers: () => usersPresent,
    decodeToFrames: async ({ onFrame, signal }) => {
      await onFrame(new Int16Array(960));
      resolveStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      const error = new Error("stopped");
      error.code = "FFMPEG_ABORTED";
      throw error;
    },
  });
  const manager = createMusicBotManager({
    db,
    ...deps,
    idlePauseMs: 120_000,
    now: () => clock,
  });
  manager.kick("cs2");
  await started;

  usersPresent = false;
  manager.scan();
  clock = 100_000;
  usersPresent = true;
  manager.scan();
  usersPresent = false;
  manager.scan();
  clock = 130_000;
  manager.scan();
  assert.equal(statusOf(db, songName), "playing");

  await manager.stop();
  assert.equal(statusOf(db, songName), "pending");
  db.close();
});

// ---------- DJ 等功率交叉淡化 ----------
//
// 帧值编码：marker*1000 + 帧序号（0 起）。10ms/帧；测试参数把
// 交叉淡化压缩到 10 帧、准备提前量 30 帧、拉满 ramp 3 帧、逐帧复查。
// 100 帧歌曲（durationMs=1000）的标准轨迹：
//   纯旧歌 89 帧 → 等功率混音 10 帧（progress = k/(N-1)，端点精确
//   old=1/new=0 与 old=0/new=1）→ 纯新歌 90 帧 = 共 189 帧；
//   300ms ramp 只出现在提前接管场景（旧歌提前结束 / 淡化中跳过）。

const unhandledRejections = [];
const onUnhandledRejection = (reason) => {
  unhandledRejections.push(reason);
};
process.on("unhandledRejection", onUnhandledRejection);

const DJ_TEST_OPTIONS = Object.freeze({
  crossfadeMs: 100,
  prepareLeadMs: 300,
  minCurrentDurationMs: 0,
  minNextDurationMs: 0,
  prepBufferMaxFrames: 20,
  rampMs: 30,
  checkIntervalFrames: 1,
});

function djEnqueue(db, principalKey, entries, channelId = "cs2") {
  return enqueueTracks(db, {
    channelId,
    principalKey,
    requesterDisplayName: `名-${principalKey}`,
    tracks: entries.map((entry) => ({
      id: String(entry.marker),
      name: `DJ歌-${entry.marker}`,
      artists: [],
      album: null,
      durationMs: entry.durationMs ?? 1000,
      fee: 0,
    })),
  });
}

function itemIdOf(db, marker) {
  return db
    .prepare("SELECT id FROM music_queue_items WHERE song_name = ?")
    .get(`DJ歌-${marker}`).id;
}

function makeDjHarness({
  frameCounts = {},
  decodeFailures = {},
  urlFailures = {},
  djOverrides = {},
  hasUsers = null,
  idlePauseMs = 120_000,
  onCapture = null,
} = {}) {
  const db = createDb();
  const captured = [];
  const decodeOrder = [];
  const logs = [];
  let activeDecodes = 0;
  let maxActiveDecodes = 0;
  let sessionsCreated = 0;
  let sessionsClosed = 0;

  function framesFor(songId) {
    if (frameCounts[songId] !== undefined) return frameCounts[songId];
    const row = db
      .prepare("SELECT duration_ms FROM music_queue_items WHERE song_id = ? LIMIT 1")
      .get(songId);
    return Math.max(1, Math.floor((row?.duration_ms ?? 1000) / 10));
  }

  const harness = {
    db,
    captured,
    decodeOrder,
    logs,
    manager: null,
    get activeDecodes() {
      return activeDecodes;
    },
    get maxActiveDecodes() {
      return maxActiveDecodes;
    },
    get sessionsCreated() {
      return sessionsCreated;
    },
    get sessionsClosed() {
      return sessionsClosed;
    },
  };

  harness.manager = createMusicBotManager({
    db,
    presenceService: { hasUsersInChannel: hasUsers ?? (() => true) },
    ffmpegRuntime: {
      probeFfmpeg: async () => ({ ffmpegPath: "/fake/ffmpeg" }),
      clearProbeCache: () => {},
    },
    loadCredential: () => ({ cookie: "MUSIC_U=fake", neteaseUserId: "1" }),
    neteaseClient: {
      getSongPlaybackUrl: async ({ songId }) => {
        if (urlFailures[songId]) {
          const error = new Error("播放地址不可用");
          error.code = urlFailures[songId];
          throw error;
        }
        return { url: `https://m701.music.126.net/${songId}.mp3` };
      },
    },
    createAudioSession: async () => {
      sessionsCreated += 1;
      return {
        identity: "music-bot:cs2",
        captureFrame: async (frame) => {
          captured.push(frame[0]);
          if (onCapture) await onCapture(frame[0], harness);
        },
        waitForPlayout: async () => {},
        close: async () => {
          sessionsClosed += 1;
        },
      };
    },
    openMediaStream: async (url) => ({
      songId: url.slice(url.lastIndexOf("/") + 1).replace(".mp3", ""),
    }),
    createByteLimit: () => null,
    decodeToFrames: async ({ mediaStream, onFrame, signal }) => {
      const songId = mediaStream.songId;
      decodeOrder.push(songId);
      const pendingFailure = decodeFailures[songId]?.shift();
      if (pendingFailure) {
        const error = new Error("解码失败");
        error.code = pendingFailure;
        throw error;
      }
      activeDecodes += 1;
      maxActiveDecodes = Math.max(maxActiveDecodes, activeDecodes);
      try {
        const total = framesFor(songId);
        for (let index = 0; index < total; index += 1) {
          if (signal?.aborted) {
            const error = new Error("播放已中止");
            error.code = "FFMPEG_ABORTED";
            throw error;
          }
          await onFrame(new Int16Array(960).fill(Number(songId) * 1000 + index));
          await new Promise((resolve) => setImmediate(resolve));
        }
        return { framesDelivered: total };
      } finally {
        activeDecodes -= 1;
      }
    },
    logger: {
      error: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
      info: (message) => logs.push(String(message)),
    },
    scanIntervalMs: 60_000,
    idlePauseMs,
    backoffInitialMs: 5,
    backoffMaxMs: 20,
    djTransition: { ...DJ_TEST_OPTIONS, ...djOverrides },
  });
  return harness;
}

function range(base, from, count) {
  return Array.from({ length: count }, (_, index) => base + from + index);
}

test("DJ 生产默认参数：10 秒淡化 = 1000 帧，剩余约 12 秒开始准备", () => {
  assert.equal(DJ_TRANSITION_DEFAULTS.crossfadeMs, 10_000);
  assert.equal(DJ_TRANSITION_DEFAULTS.crossfadeMs / 10, 1000); // 1000 个 10ms 帧
  assert.equal(DJ_TRANSITION_DEFAULTS.prepareLeadMs, 12_000);
  assert.ok(
    DJ_TRANSITION_DEFAULTS.prepareLeadMs > DJ_TRANSITION_DEFAULTS.crossfadeMs
  );
  // 缓冲上限保持 8 秒（800 帧 = 1,536,000 字节），小于淡化时长：
  // 就绪门槛取 min(1000, 800)，淡化期间解码器持续补充（见下方专项测试）
  assert.equal(DJ_TRANSITION_DEFAULTS.prepBufferMaxFrames, 800);
  assert.equal(DJ_TRANSITION_DEFAULTS.prepBufferMaxFrames * 1920, 1_536_000);
});

test("缓冲上限小于淡化帧数：淡化仍走满全部帧并靠实时补充完成", async () => {
  // 缩放模型：30 帧淡化 vs 10 帧缓冲（与生产 1000 帧 vs 800 帧同构）
  const h = makeDjHarness({
    frameCounts: { 1: 120 }, // 旧歌实际比 duration_ms 长：淡化不得被压缩
    djOverrides: {
      crossfadeMs: 300,
      prepareLeadMs: 500,
      prepBufferMaxFrames: 10,
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 20 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-20"), "finished");
  assert.equal(h.maxActiveDecodes, 2);
  // 淡化走满 30 帧：末混音帧 progress=1 → 恰为纯新歌第 29 帧
  assert.ok(h.captured.includes(20029));
  // 走满后无 ramp：交接后纯新歌从第 30 帧连续播到第 99 帧
  assert.deepEqual(h.captured.slice(-70), range(20000, 30, 70));
  // 旧歌尾部（第 99~119 帧）只在淡化完整走满后被切断，绝不提前
  assert.equal(
    h.captured.some((value) => value >= 1099 && value <= 1119),
    false
  );
  assert.equal(h.activeDecodes, 0);
  h.db.close();
});

test("DJ 关闭时行为与当前版本完全一致：严格串行、无第二解码、无混音", async () => {
  const h = makeDjHarness();
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  h.manager.kick("cs2");
  await drain(h.manager);
  assert.equal(h.maxActiveDecodes, 1);
  assert.deepEqual(h.decodeOrder, ["1", "2"]);
  assert.deepEqual(h.captured, [...range(1000, 0, 100), ...range(2000, 0, 100)]);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  h.db.close();
});

test("DJ 开启无下一首：正常播完，不启动第二个 FFmpeg", async () => {
  const h = makeDjHarness();
  djEnqueue(h.db, "user-a", [{ marker: 1 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager);
  assert.deepEqual(h.decodeOrder, ["1"]);
  assert.deepEqual(h.captured, range(1000, 0, 100));
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  h.db.close();
});

test("duration 无效时回退普通串行播放", async () => {
  const h = makeDjHarness({ frameCounts: { 1: 50 } });
  djEnqueue(h.db, "user-a", [{ marker: 1, durationMs: 0 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager);
  assert.equal(h.maxActiveDecodes, 1);
  assert.deepEqual(h.captured, [...range(1000, 0, 50), ...range(2000, 0, 100)]);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  h.db.close();
});

test("当前歌太短时回退普通串行播放，不强行切歌", async () => {
  const h = makeDjHarness({ djOverrides: { minCurrentDurationMs: 500 } });
  djEnqueue(h.db, "user-a", [{ marker: 1, durationMs: 300 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager);
  assert.equal(h.maxActiveDecodes, 1);
  assert.deepEqual(h.captured.slice(0, 30), range(1000, 0, 30));
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  h.db.close();
});

test("下一首准备成功并进入 crossfade：等功率混音 + 事务交接 + 不从头播放", async () => {
  let handoverChecked = false;
  let statusesAtTakeover = null;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 2010 && !handoverChecked) {
        handoverChecked = true;
        // 第一个纯新歌帧：交接事务必须已经完成且原子可见
        statusesAtTakeover = {
          old: statusOf(h2.db, "DJ歌-1"),
          next: statusOf(h2.db, "DJ歌-2"),
          startedAt: h2.db
            .prepare("SELECT started_at FROM music_queue_items WHERE song_name = 'DJ歌-2'")
            .get().started_at,
        };
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager);

  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  assert.deepEqual(h.decodeOrder, ["1", "2"]);
  assert.equal(h.maxActiveDecodes, 2); // 仅重叠准备期短暂两路解码
  assert.equal(h.sessionsCreated, 1); // 全程一个 LiveKit 发布会话
  assert.equal(h.sessionsClosed, 1);

  // 纯旧歌 89 帧
  assert.deepEqual(h.captured.slice(0, 89), range(1000, 0, 89));
  // 10 帧等功率混音：progress = k/(N-1)，完整 0→1 曲线
  const mixed = h.captured.slice(89, 99);
  assert.equal(mixed[0], 1089); // 起点 oldGain=1、newGain=0：恰为纯旧歌帧
  for (let k = 1; k < 10; k += 1) {
    const gains = equalPowerGains(k / 9);
    assert.equal(
      mixed[k],
      Math.round((1089 + k) * gains.oldGain + (2000 + k) * gains.newGain)
    );
  }
  assert.equal(mixed[9], 2009); // 终点 oldGain=0、newGain=1：恰为纯新歌帧
  // 走满的淡化无需 ramp：交接后纯新歌从第 10 帧连续播到第 99 帧
  const tail = h.captured.slice(99);
  assert.deepEqual(tail, range(2000, 10, 90));
  assert.equal(h.captured.length, 189);

  assert.equal(handoverChecked, true);
  assert.deepEqual(
    { old: statusesAtTakeover.old, next: statusesAtTakeover.next },
    { old: "finished", next: "playing" }
  );
  assert.ok(Number.isSafeInteger(statusesAtTakeover.startedAt)); // 进度含淡化部分
  h.db.close();
});

test("连环交接保持公平交替：A1→B1→A2→B2 全部 finished", async () => {
  const h = makeDjHarness();
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 3 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }, { marker: 4 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.deepEqual(h.decodeOrder, ["1", "2", "3", "4"]);
  for (const marker of [1, 2, 3, 4]) {
    assert.equal(statusOf(h.db, `DJ歌-${marker}`), "finished");
  }
  assert.equal(h.sessionsCreated, 1);
  assert.equal(h.captured[h.captured.length - 1], 4099); // 最后一首完整播到尾
  assert.equal(h.activeDecodes, 0);
  h.db.close();
});

test("reservation 失效（候选被取消）后重新选择，被取消歌曲绝不出声", async () => {
  let cancelled = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1075 && !cancelled) {
        cancelled = true;
        cancelQueueItem(h2.db, {
          channelId: "cs2",
          queueItemId: itemIdOf(h2.db, 2),
          principalKey: "user-b",
        });
      }
      // 被取消的歌曲任何时刻都不允许进入 playing
      assert.notEqual(statusOf(h2.db, "DJ歌-2"), "playing");
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 3 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "cancelled");
  assert.equal(statusOf(h.db, "DJ歌-3"), "finished");
  assert.equal(h.decodeOrder[0], "1");
  assert.ok(h.decodeOrder.includes("3"));
  assert.equal(h.activeDecodes, 0);
  h.db.close();
});

test("置顶后候选重新验证：置顶歌曲插队播放", async () => {
  let prioritized = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1075 && !prioritized) {
        prioritized = true;
        prioritizeQueueItem(h2.db, {
          channelId: "cs2",
          queueItemId: itemIdOf(h2.db, 3),
        });
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 3 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  for (const marker of [1, 2, 3]) {
    assert.equal(statusOf(h.db, `DJ歌-${marker}`), "finished");
  }
  // 置顶的 3 必须先于 2 播放
  const startedAt = (marker) =>
    h.db
      .prepare("SELECT started_at FROM music_queue_items WHERE song_name = ?")
      .get(`DJ歌-${marker}`).started_at;
  assert.ok(startedAt(3) <= startedAt(2));
  h.db.close();
});

test("随机播放后候选重新验证", async () => {
  let shuffled = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1075 && !shuffled) {
        shuffled = true;
        // 强制交换 user-b 桶内顺序：候选从 2 变为 4
        shufflePendingQueue(h2.db, {
          channelId: "cs2",
          randomIndex: () => 0,
        });
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }, { marker: 4 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  for (const marker of [1, 2, 4]) {
    assert.equal(statusOf(h.db, `DJ歌-${marker}`), "finished");
  }
  const startedAt = (marker) =>
    h.db
      .prepare("SELECT started_at FROM music_queue_items WHERE song_name = ?")
      .get(`DJ歌-${marker}`).started_at;
  assert.ok(startedAt(4) <= startedAt(2)); // 洗牌后 4 先播
  h.db.close();
});

test("当前歌提前结束：新歌短时间拉满接管，不重复播放开头", async () => {
  const h = makeDjHarness({ frameCounts: { 1: 95 } });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  // 89 纯旧 + 6 混音（旧歌 95 帧耗尽）+ 3 ramp + 91 纯新 = 189
  assert.equal(h.captured.length, 189);
  assert.equal(h.captured[h.captured.length - 1], 2099);
  // 新歌帧严格递增（无重复、无从头）
  const pureNew = h.captured.slice(98);
  for (let index = 1; index < pureNew.length; index += 1) {
    assert.ok(pureNew[index] > pureNew[index - 1]);
  }
  h.db.close();
});

test("当前歌比 duration_ms 更长：过渡完成后终止旧歌尾部", async () => {
  const h = makeDjHarness({ frameCounts: { 1: 120 } });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 20 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-20"), "finished");
  // 旧歌第 99~119 帧（值 1099~1119）在淡化结束后被切断，绝不再出声
  assert.equal(
    h.captured.some((value) => value >= 1099 && value <= 1119),
    false
  );
  assert.equal(h.captured.length, 189);
  assert.equal(h.captured[h.captured.length - 1], 20099);
  h.db.close();
});

test("交叉淡化期间暂停/恢复：两路解码与过渡进度一起冻结", async () => {
  let pausedOnce = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1089 && !pausedOnce) {
        pausedOnce = true;
        h2.manager.setPaused("cs2", true);
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");

  // 等待暂停生效（首个混音帧推送后立即暂停）
  const started = Date.now();
  while (!pausedOnce && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(pausedOnce, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const frozenLength = h.captured.length;
  const state = h.manager.getPlaybackState("cs2");
  assert.equal(state.paused, true);
  assert.equal(state.transitionState, "crossfading");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.captured.length, frozenLength); // 暂停期间零推送

  h.manager.setPaused("cs2", false);
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  assert.equal(h.captured.length, 189); // 恢复后从同一过渡进度继续
  h.db.close();
});

test("交叉淡化期间点下一首：旧歌立即结束标记 skipped，新歌快速拉满且不重播", async () => {
  let skipIssued = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (h2.captured.length === 92 && !skipIssued) {
        skipIssued = true;
        h2.manager.skip("cs2").catch(() => {});
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(skipIssued, true);
  assert.equal(statusOf(h.db, "DJ歌-1"), "skipped");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  assert.equal(h.sessionsClosed, 1); // 淡化跳过不关闭发布会话（结束时才关）
  // 89 纯旧 + 3 混音 + 3 ramp + 94 纯新 = 189；新歌从第 6 帧继续
  assert.equal(h.captured.length, 189);
  assert.deepEqual(h.captured.slice(95), range(2000, 6, 94));
  h.db.close();
});

test("preparing 阶段清空队列：释放预取解码器，当前歌不受影响", async () => {
  let clearedAt = 0;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1080 && !clearedAt) {
        clearedAt = h2.captured.length;
        clearPendingQueue(h2.db, { channelId: "cs2" });
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.ok(clearedAt > 0);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "cancelled");
  assert.deepEqual(h.captured, range(1000, 0, 100)); // 无混音，旧歌完整播完
  assert.equal(h.activeDecodes, 0); // 预取解码任务被取消释放
  assert.equal(h.decodeOrder.length, 2); // 预取确实启动过
  h.db.close();
});

test("关闭 DJ：预取立即取消，当前歌继续普通串行", async () => {
  let toggledOff = false;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 1080 && !toggledOff) {
        toggledOff = true;
        setDjTransitionEnabled(h2.db, { channelId: "cs2", enabled: false });
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(toggledOff, true);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  // 关闭后无混音：帧序完全串行
  assert.deepEqual(h.captured, [...range(1000, 0, 100), ...range(2000, 0, 100)]);
  h.db.close();
});

test("无人频道退出：当前流与预取流全部释放，歌曲回到 pending 不丢失", async () => {
  let present = true;
  const h = makeDjHarness({
    hasUsers: () => present,
    idlePauseMs: 0,
    onCapture: (value, h2) => {
      if (value === 1080 && present) {
        present = false;
        h2.manager.scan();
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }]);
  djEnqueue(h.db, "user-b", [{ marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(present, false);
  assert.equal(statusOf(h.db, "DJ歌-1"), "pending"); // requeue 恢复
  assert.equal(statusOf(h.db, "DJ歌-2"), "pending"); // reservation 失效不丢歌
  assert.equal(h.activeDecodes, 0);
  assert.equal(h.sessionsClosed, h.sessionsCreated);
  h.db.close();
});

test("淡化中服务停止：释放两路解码，双歌都安全回到 pending", async () => {
  let stopPromise = null;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (h2.captured.length === 92 && !stopPromise) {
        stopPromise = h2.manager.stop();
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.ok(stopPromise);
  await stopPromise;
  assert.equal(statusOf(h.db, "DJ歌-1"), "pending");
  assert.equal(statusOf(h.db, "DJ歌-2"), "pending");
  assert.equal(h.activeDecodes, 0);
  assert.equal(h.sessionsClosed, h.sessionsCreated);
  h.db.close();
});

test("交接完成后服务停止：接管中的新歌由 worker 兜底放回 pending", async () => {
  let stopPromise = null;
  const h = makeDjHarness({
    onCapture: (value, h2) => {
      if (value === 2013 && !stopPromise) {
        stopPromise = h2.manager.stop();
      }
    },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.ok(stopPromise);
  await stopPromise;
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished"); // 交接前已正常结束
  assert.equal(statusOf(h.db, "DJ歌-2"), "pending"); // 新歌被安全放回
  assert.equal(h.activeDecodes, 0);
  h.db.close();
});

test("下一首媒体失败：当前歌不受影响，随后串行按既有分类重试", async () => {
  const h = makeDjHarness({
    decodeFailures: { 2: ["MEDIA_FETCH_FAILED"] },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished"); // 串行重试成功
  // 预取失败 → 当前歌完整串行播完（无混音帧）
  assert.deepEqual(h.captured.slice(0, 100), range(1000, 0, 100));
  assert.deepEqual(h.decodeOrder, ["1", "2", "2"]);
  h.db.close();
});

test("下一首 FFmpeg 失败：退化串行且不重播当前歌", async () => {
  const h = makeDjHarness({
    decodeFailures: { 2: ["FFMPEG_START_FAILED"] },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "finished");
  // 当前歌帧值 1000~1099 只出现一次：绝不重播
  const firstSongFrames = h.captured.filter((value) => value >= 1000 && value < 2000);
  assert.deepEqual(firstSongFrames, range(1000, 0, 100));
  h.db.close();
});

test("下一首网易云登录失效：沿用既有 skipped 语义，日志不含敏感数据", async () => {
  const h = makeDjHarness({
    urlFailures: { 2: "NETEASE_PLAYBACK_SESSION_INVALID" },
  });
  djEnqueue(h.db, "user-a", [{ marker: 1 }, { marker: 2 }]);
  setDjTransitionEnabled(h.db, { channelId: "cs2", enabled: true });
  h.manager.kick("cs2");
  await drain(h.manager, 5000);
  assert.equal(statusOf(h.db, "DJ歌-1"), "finished");
  assert.equal(statusOf(h.db, "DJ歌-2"), "skipped");
  assert.deepEqual(h.captured, range(1000, 0, 100));
  assert.ok(h.logs.length > 0);
  for (const line of h.logs) {
    assert.equal(line.includes("MUSIC_U"), false);
    assert.equal(line.includes("http"), false);
    assert.equal(line.includes("126.net"), false);
    assert.equal(line.includes("user-a"), false);
    assert.equal(line.includes("user-b"), false);
  }
  h.db.close();
});

test("DJ 全部场景不产生 unhandledRejection", async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.deepEqual(unhandledRejections, []);
});
