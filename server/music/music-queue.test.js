import test from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateMusicQueue } from "./queue-migrate.js";
import {
  CHANNEL_QUEUE_LIMIT,
  MUSIC_QUEUE_ERROR,
  USER_QUEUE_LIMIT,
  cancelPendingItemsForPrincipal,
  cancelPendingItemsForPrincipalInChannel,
  cancelQueueItem,
  clearPendingQueue,
  claimNextQueueItem,
  enqueueTracks,
  finishQueueItem,
  getQueueSnapshot,
  getRemainingQueueCapacity,
  hasPendingItems,
  listChannelsWithPending,
  markQueueItemPlaybackStarted,
  recoverInterruptedQueueItems,
  removeQueueDataForPrincipal,
  requeueClaimedItem,
  prioritizeQueueItem,
  shufflePendingQueue,
} from "./music-queue.js";

// claim 返回 receipt；多数测试只关心 queueItem 本身
function claimItem(db, options) {
  return claimNextQueueItem(db, options)?.queueItem ?? null;
}

// 全部使用 in-memory / 临时数据库，绝不触碰真实生产数据

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  db.prepare("INSERT INTO channels VALUES ('cs2', 'CS2')").run();
  db.prepare("INSERT INTO channels VALUES ('apex', 'Apex')").run();
  migrateMusicQueue(db);
  return db;
}

function makeTrack(label, id) {
  return {
    id: String(id),
    name: label,
    artists: [{ id: "1", name: "歌手" }],
    album: { id: "2", name: "专辑", picUrl: "https://p1.music.126.net/a.jpg" },
    durationMs: 240000,
    fee: 0,
  };
}

let nextSongId = 1;
let nextRequesterIndex = 1;
const requesterNames = new Map();
function enqueueMany(db, principalKey, labels, channelId = "cs2") {
  // 生产中 displayName 来自 req.authUser 的昵称，绝不包含 principal key
  if (!requesterNames.has(principalKey)) {
    requesterNames.set(principalKey, `点歌人${nextRequesterIndex++}`);
  }
  return enqueueTracks(db, {
    channelId,
    principalKey,
    requesterDisplayName: requesterNames.get(principalKey),
    tracks: labels.map((label) => makeTrack(label, nextSongId++)),
  });
}

function snapshotLabels(db, channelId = "cs2", viewer = { principalKey: "viewer", isAdmin: false }) {
  return getQueueSnapshot(db, { channelId, viewer }).items.map(
    (item) => item.song.name
  );
}

test("A50 + B2：快照顺序精确交替", () => {
  const db = createDb();
  enqueueMany(db, "user-a", Array.from({ length: 50 }, (_, i) => `A${i + 1}`));
  enqueueMany(db, "user-b", ["B1", "B2"]);

  const expected = [
    "A1", "B1", "A2", "B2",
    ...Array.from({ length: 48 }, (_, i) => `A${i + 3}`),
  ];
  assert.deepEqual(snapshotLabels(db), expected);
  db.close();
});

test("A/B/C 轮询消费（claim 顺序）+ 同用户 FIFO + B 耗尽后继续 A", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2", "A3"]);
  enqueueMany(db, "user-b", ["B1"]);
  enqueueMany(db, "user-c", ["C1", "C2"]);

  const played = [];
  for (;;) {
    const item = claimItem(db, { channelId: "cs2" });
    if (!item) break;
    played.push(item.song_name);
    finishQueueItem(db, { queueItemId: item.id, outcome: "finished" });
  }
  assert.deepEqual(played, ["A1", "B1", "C1", "A2", "C2", "A3"]);
  db.close();
});

test("新用户动态加入：A 播放一首后 B 加入，B 下一首优先", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2", "A3"]);

  const first = claimItem(db, { channelId: "cs2" });
  assert.equal(first.song_name, "A1");
  finishQueueItem(db, { queueItemId: first.id, outcome: "finished" });

  enqueueMany(db, "user-b", ["B1"]);
  const second = claimItem(db, { channelId: "cs2" });
  assert.equal(second.song_name, "B1");
  finishQueueItem(db, { queueItemId: second.id, outcome: "finished" });

  const third = claimItem(db, { channelId: "cs2" });
  assert.equal(third.song_name, "A2");
  db.close();
});

test("空桶重新加入后继续轮询（桶顺序稳定）", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1"]);
  enqueueMany(db, "user-b", ["B1"]);

  let item = claimItem(db, { channelId: "cs2" });
  finishQueueItem(db, { queueItemId: item.id, outcome: "finished" });
  item = claimItem(db, { channelId: "cs2" });
  finishQueueItem(db, { queueItemId: item.id, outcome: "finished" });
  assert.equal(claimItem(db, { channelId: "cs2" }), null);

  // B 重新添加，桶已存在不再新建
  enqueueMany(db, "user-b", ["B2"]);
  enqueueMany(db, "user-a", ["A2"]);
  const bucketCount = db
    .prepare("SELECT COUNT(*) AS count FROM music_queue_buckets WHERE channel_id = 'cs2'")
    .get().count;
  assert.equal(bucketCount, 2);

  // 游标停在 B(2) → 回绕到 A
  assert.deepEqual(snapshotLabels(db), ["A2", "B2"]);
  db.close();
});

test("每频道最多一个 playing；claim 原子性", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2"]);

  const first = claimItem(db, { channelId: "cs2" });
  assert.equal(first.status, "playing");
  assert.ok(first.started_at);

  // 已有 playing 时不再领取
  assert.equal(claimItem(db, { channelId: "cs2" }), null);

  finishQueueItem(db, { queueItemId: first.id, outcome: "finished" });
  const second = claimItem(db, { channelId: "cs2" });
  assert.equal(second.song_name, "A2");
  db.close();
});

test("第一帧校准 started_at，快照返回安全且有界的播放进度", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1"]);
  const receipt = claimNextQueueItem(db, { channelId: "cs2", now: 1_000 });

  const calibrated = markQueueItemPlaybackStarted(db, {
    queueItemId: receipt.queueItem.id,
    now: 5_000,
  });
  assert.equal(calibrated.startedAt, 5_000);

  const snapshot = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "user-a", isAdmin: false },
    now: 6_250,
  });
  assert.deepEqual(snapshot.nowPlaying.playback, {
    startedAt: 5_000,
    elapsedMs: 1_250,
    durationMs: 240_000,
    paused: false,
  });
  assert.equal(snapshot.nowPlaying.requester.isCurrentUser, true);
  assert.ok(!JSON.stringify(snapshot).includes("principal_key"));

  const completed = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "viewer", isAdmin: false },
    now: 999_999,
  });
  assert.equal(completed.nowPlaying.playback.elapsedMs, 240_000);

  finishQueueItem(db, {
    queueItemId: receipt.queueItem.id,
    outcome: "finished",
  });
  assert.equal(
    markQueueItemPlaybackStarted(db, {
      queueItemId: receipt.queueItem.id,
      now: 10_000,
    }),
    null
  );
  db.close();
});

test("finish 状态转换：finished/skipped/failed，且只处理 playing", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2", "A3"]);

  for (const outcome of ["finished", "skipped", "failed"]) {
    const item = claimItem(db, { channelId: "cs2" });
    finishQueueItem(db, {
      queueItemId: item.id,
      outcome,
      failureCode: outcome === "failed" ? "TEST_FAILURE" : null,
    });
    const row = db
      .prepare("SELECT status, finished_at, failure_code FROM music_queue_items WHERE id = ?")
      .get(item.id);
    assert.equal(row.status, outcome);
    assert.ok(row.finished_at);
    if (outcome === "failed") assert.equal(row.failure_code, "TEST_FAILURE");
  }

  // 非 playing 项目与无效 outcome 被拒绝
  assert.throws(
    () => finishQueueItem(db, { queueItemId: 99999, outcome: "finished" }),
    (error) => error.code === MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND
  );
  enqueueMany(db, "user-a", ["A4"]);
  const pendingId = db
    .prepare("SELECT id FROM music_queue_items WHERE status = 'pending'")
    .get().id;
  assert.throws(() =>
    finishQueueItem(db, { queueItemId: pendingId, outcome: "finished" })
  );
  assert.throws(() =>
    finishQueueItem(db, { queueItemId: pendingId, outcome: "cancelled" })
  );
  db.close();
});

test("recoverInterruptedQueueItems：playing 恢复 pending，可重复执行", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2"]);
  const item = claimItem(db, { channelId: "cs2" });
  assert.equal(item.song_name, "A1");

  const recovered = recoverInterruptedQueueItems(db);
  assert.equal(recovered, 1);
  const row = db
    .prepare("SELECT status, started_at FROM music_queue_items WHERE id = ?")
    .get(item.id);
  assert.equal(row.status, "pending");
  assert.equal(row.started_at, null);

  // 可重复执行
  assert.equal(recoverInterruptedQueueItems(db), 0);

  // 恢复后 A1 仍然是下一首（桶内 FIFO 保持）
  assert.equal(claimItem(db, { channelId: "cs2" }).song_name, "A1");
  db.close();
});

test("不同频道队列完全隔离", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["CS-A1"], "cs2");
  enqueueMany(db, "user-a", ["APEX-A1"], "apex");

  assert.deepEqual(snapshotLabels(db, "cs2"), ["CS-A1"]);
  assert.deepEqual(snapshotLabels(db, "apex"), ["APEX-A1"]);

  const item = claimItem(db, { channelId: "cs2" });
  assert.equal(item.song_name, "CS-A1");
  // cs2 有 playing 不影响 apex 领取
  assert.equal(claimItem(db, { channelId: "apex" }).song_name, "APEX-A1");
  db.close();
});

test("同一用户多次连接仍是同一个桶；guest 独立桶", () => {
  const db = createDb();
  // 同一 principal 多次添加（模拟多标签页 / 多语音连接）
  enqueueMany(db, "user-a", ["A1"]);
  enqueueMany(db, "user-a", ["A2"]);
  enqueueMany(db, "guest:uuid-1", ["G1"]);

  const buckets = db
    .prepare(
      "SELECT principal_key, bucket_order FROM music_queue_buckets WHERE channel_id = 'cs2' ORDER BY bucket_order"
    )
    .all();
  assert.deepEqual(buckets, [
    { principal_key: "user-a", bucket_order: 1 },
    { principal_key: "guest:uuid-1", bucket_order: 2 },
  ]);
  assert.deepEqual(snapshotLabels(db), ["A1", "G1", "A2"]);
  db.close();
});

test("用户上限 50：截断与拒绝", () => {
  const db = createDb();
  const result = enqueueMany(
    db,
    "user-a",
    Array.from({ length: 55 }, (_, i) => `A${i + 1}`)
  );
  assert.equal(result.addedCount, USER_QUEUE_LIMIT);
  assert.equal(result.truncated, true);

  assert.throws(
    () => enqueueMany(db, "user-a", ["more"]),
    (error) => error.code === MUSIC_QUEUE_ERROR.USER_LIMIT
  );
  // 其他用户不受影响
  assert.equal(enqueueMany(db, "user-b", ["B1"]).addedCount, 1);
  db.close();
});

test("频道上限 500：截断与拒绝", () => {
  const db = createDb();
  for (let user = 0; user < 10; user += 1) {
    enqueueMany(
      db,
      `user-${user}`,
      Array.from({ length: 50 }, (_, i) => `U${user}-${i}`)
    );
  }
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM music_queue_items WHERE channel_id = 'cs2' AND status = 'pending'"
      )
      .get().count,
    CHANNEL_QUEUE_LIMIT
  );

  assert.throws(
    () => enqueueMany(db, "user-fresh", ["X1"]),
    (error) => error.code === MUSIC_QUEUE_ERROR.CHANNEL_LIMIT
  );
  const capacity = getRemainingQueueCapacity(db, "cs2", "user-fresh");
  assert.equal(capacity.remaining, 0);
  db.close();
});

test("批量添加原子性：中途失败整体回滚", () => {
  const db = createDb();
  const badBatch = [
    makeTrack("好歌", 9001),
    { ...makeTrack("坏歌", 9002), name: null }, // song_name NOT NULL → 触发失败
  ];
  assert.throws(() =>
    enqueueTracks(db, {
      channelId: "cs2",
      principalKey: "user-a",
      requesterDisplayName: "A",
      tracks: badBatch,
    })
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM music_queue_items").get().count,
    0
  );
  db.close();
});

test("取消：本人可取消、他人被拒、admin 可取消任意 pending", () => {
  const db = createDb();
  const aResult = enqueueMany(db, "user-a", ["A1"]);
  enqueueMany(db, "user-b", ["B1"]);
  const aItemId = Number(aResult.queueItemIds[0]);

  // 普通用户 B 不能取消 A 的歌
  assert.throws(
    () =>
      cancelQueueItem(db, {
        channelId: "cs2",
        queueItemId: aItemId,
        principalKey: "user-b",
        isAdmin: false,
      }),
    (error) => error.code === MUSIC_QUEUE_ERROR.FORBIDDEN
  );

  // 本人取消成功，顺序立即重新计算
  cancelQueueItem(db, {
    channelId: "cs2",
    queueItemId: aItemId,
    principalKey: "user-a",
    isAdmin: false,
  });
  assert.deepEqual(snapshotLabels(db), ["B1"]);

  // admin 可取消任何人的 pending
  const bItemId = db
    .prepare("SELECT id FROM music_queue_items WHERE status = 'pending'")
    .get().id;
  cancelQueueItem(db, {
    channelId: "cs2",
    queueItemId: bItemId,
    principalKey: "admin-user",
    isAdmin: true,
  });
  assert.deepEqual(snapshotLabels(db), []);

  // 已取消项目不能再取消
  assert.throws(
    () =>
      cancelQueueItem(db, {
        channelId: "cs2",
        queueItemId: bItemId,
        principalKey: "user-b",
        isAdmin: false,
      }),
    (error) => error.code === MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND
  );
  db.close();
});

test("cancelPendingItemsForPrincipal 只取消自己的 pending", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["A1", "A2"]);
  enqueueMany(db, "user-b", ["B1"]);
  enqueueMany(db, "user-a", ["APEX-A"], "apex");

  const cancelled = cancelPendingItemsForPrincipal(db, "user-a");
  assert.equal(cancelled, 3);
  assert.deepEqual(snapshotLabels(db, "cs2"), ["B1"]);
  assert.deepEqual(snapshotLabels(db, "apex"), []);
  db.close();
});

test("removeQueueDataForPrincipal 删除 pending 和桶，不影响他人", () => {
  const db = createDb();
  enqueueMany(db, "doomed", ["D1", "D2"]);
  enqueueMany(db, "user-b", ["B1"]);

  removeQueueDataForPrincipal(db, "doomed");

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM music_queue_items WHERE principal_key = 'doomed'")
      .get().count,
    0
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM music_queue_buckets WHERE principal_key = 'doomed'")
      .get().count,
    0
  );
  assert.deepEqual(snapshotLabels(db), ["B1"]);
  db.close();
});

test("服务重启后队列与游标保留（文件数据库）", async () => {
  const tempRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "novaspeak-queue-restart-")
  );
  try {
    const databasePath = path.join(tempRoot, "queue.db");
    let db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO channels VALUES ('cs2', 'CS2')").run();
    migrateMusicQueue(db);

    enqueueTracks(db, {
      channelId: "cs2",
      principalKey: "user-a",
      requesterDisplayName: "A",
      tracks: [makeTrack("A1", 1), makeTrack("A2", 2)],
    });
    enqueueTracks(db, {
      channelId: "cs2",
      principalKey: "user-b",
      requesterDisplayName: "B",
      tracks: [makeTrack("B1", 3)],
    });
    const claimed = claimItem(db, { channelId: "cs2" });
    assert.equal(claimed.song_name, "A1");
    finishQueueItem(db, { queueItemId: claimed.id, outcome: "finished" });
    db.close();

    // 模拟重启：重新打开数据库
    db = new Database(databasePath);
    db.pragma("foreign_keys = ON");
    const state = db
      .prepare("SELECT last_served_bucket_order FROM music_queue_state WHERE channel_id = 'cs2'")
      .get();
    assert.equal(state.last_served_bucket_order, 1);
    // 游标保留：下一首应轮到 B
    const next = claimItem(db, { channelId: "cs2" });
    assert.equal(next.song_name, "B1");
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("快照不暴露 principal_key / guest UUID，canCancel 正确", () => {
  const db = createDb();
  enqueueMany(db, "guest:secret-uuid-42", ["G1"]);
  enqueueMany(db, "user-a", ["A1"]);

  const snapshot = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "user-a", isAdmin: false },
  });
  const dump = JSON.stringify(snapshot);
  assert.ok(!dump.includes("secret-uuid-42"));
  assert.ok(!dump.includes("principal_key"));
  assert.ok(!dump.includes("principalKey"));

  const guestItem = snapshot.items.find((item) => item.song.name === "G1");
  const ownItem = snapshot.items.find((item) => item.song.name === "A1");
  assert.equal(guestItem.requester.isCurrentUser, false);
  assert.equal(guestItem.canCancel, false);
  assert.equal(ownItem.requester.isCurrentUser, true);
  assert.equal(ownItem.canCancel, true);

  // admin 视角全部可取消
  const adminView = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "admin-1", isAdmin: true },
  });
  assert.ok(adminView.items.every((item) => item.canCancel));

  // 不存在的频道
  assert.throws(
    () =>
      getQueueSnapshot(db, {
        channelId: "no-such",
        viewer: { principalKey: "user-a", isAdmin: false },
      }),
    (error) => error.code === MUSIC_QUEUE_ERROR.CHANNEL_NOT_FOUND
  );
  db.close();
});

test("claim receipt：包含前后游标，requeue 恢复公平位置（A1 仍是 A1）", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["RA1", "RA2"]);
  enqueueMany(db, "user-b", ["RB1"]);

  const receipt = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(receipt.queueItem.song_name, "RA1");
  assert.equal(receipt.previousLastServedBucketOrder, 0);
  assert.equal(receipt.servedBucketOrder, 1);

  // 基础设施故障：回退并恢复游标
  const requeued = requeueClaimedItem(db, {
    queueItemId: receipt.queueItem.id,
    previousLastServedBucketOrder: receipt.previousLastServedBucketOrder,
  });
  assert.equal(requeued, true);

  const row = db
    .prepare("SELECT status, started_at, failure_code FROM music_queue_items WHERE id = ?")
    .get(receipt.queueItem.id);
  assert.equal(row.status, "pending");
  assert.equal(row.started_at, null);
  assert.equal(row.failure_code, null);

  // 恢复后下一首仍是 A1，而不是 B1
  const retry = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(retry.queueItem.song_name, "RA1");

  // 成功后游标推进，轮到 B
  finishQueueItem(db, { queueItemId: retry.queueItem.id, outcome: "finished" });
  assert.equal(claimItem(db, { channelId: "cs2" }).song_name, "RB1");

  // 非 playing 项目 requeue 幂等返回 false
  assert.equal(
    requeueClaimedItem(db, {
      queueItemId: receipt.queueItem.id,
      previousLastServedBucketOrder: 0,
    }),
    false
  );
  db.close();
});

test("随机播放只打乱桶内顺序，A/B 公平交替保持不变", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["SA1", "SA2", "SA3"]);
  enqueueMany(db, "user-b", ["SB1", "SB2"]);

  const beforeRevision = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "viewer", isAdmin: false },
  }).revision;
  const result = shufflePendingQueue(db, {
    channelId: "cs2",
    randomIndex: () => 0,
    now: 123_456,
  });

  assert.equal(result.shuffledCount, 5);
  assert.equal(result.revision, beforeRevision + 1);
  assert.deepEqual(snapshotLabels(db), ["SA2", "SB2", "SA3", "SB1", "SA1"]);
  db.close();
});

test("置顶歌曲抢占下一首但不推进公平游标，之后继续 A/B 交替", () => {
  const db = createDb();
  const a = enqueueMany(db, "user-a", ["PA1", "PA2", "PA3"]);
  enqueueMany(db, "user-b", ["PB1", "PB2"]);

  // 正常消费 A1，公平游标停在 A。
  const first = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(first.queueItem.song_name, "PA1");
  finishQueueItem(db, { queueItemId: first.queueItem.id, outcome: "finished" });

  prioritizeQueueItem(db, {
    channelId: "cs2",
    queueItemId: Number(a.queueItemIds[2]),
  });
  const snapshot = getQueueSnapshot(db, {
    channelId: "cs2",
    viewer: { principalKey: "viewer", isAdmin: false },
  });
  assert.equal(snapshot.items[0].song.name, "PA3");
  assert.equal(snapshot.items[0].prioritized, true);
  assert.ok(!JSON.stringify(snapshot).includes("priority_order"));

  const priority = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(priority.queueItem.song_name, "PA3");
  assert.equal(priority.priorityClaim, true);
  assert.equal(priority.previousLastServedBucketOrder, 1);
  finishQueueItem(db, {
    queueItemId: priority.queueItem.id,
    outcome: "finished",
  });

  // 置顶不消费 A 的轮次，仍轮到 B1，然后才回 A2。
  const b1 = claimItem(db, { channelId: "cs2" });
  assert.equal(b1.song_name, "PB1");
  finishQueueItem(db, { queueItemId: b1.id, outcome: "finished" });
  assert.equal(claimItem(db, { channelId: "cs2" }).song_name, "PA2");
  db.close();
});

test("连续置顶时最后一次操作最优先，基础设施回退后仍保持置顶", () => {
  const db = createDb();
  const added = enqueueMany(db, "user-a", ["TP1", "TP2", "TP3"]);
  prioritizeQueueItem(db, {
    channelId: "cs2",
    queueItemId: Number(added.queueItemIds[1]),
  });
  prioritizeQueueItem(db, {
    channelId: "cs2",
    queueItemId: Number(added.queueItemIds[2]),
  });
  assert.deepEqual(snapshotLabels(db), ["TP3", "TP2", "TP1"]);

  const receipt = claimNextQueueItem(db, { channelId: "cs2" });
  assert.equal(receipt.queueItem.song_name, "TP3");
  requeueClaimedItem(db, {
    queueItemId: receipt.queueItem.id,
    previousLastServedBucketOrder: receipt.previousLastServedBucketOrder,
  });
  assert.equal(claimNextQueueItem(db, { channelId: "cs2" }).queueItem.song_name, "TP3");
  db.close();
});

test("hasPendingItems / listChannelsWithPending", () => {
  const db = createDb();
  assert.equal(hasPendingItems(db, "cs2"), false);
  assert.deepEqual(listChannelsWithPending(db), []);

  enqueueMany(db, "user-a", ["P1"]);
  enqueueMany(db, "user-a", ["P2"], "apex");
  assert.equal(hasPendingItems(db, "cs2"), true);
  assert.deepEqual(listChannelsWithPending(db).sort(), ["apex", "cs2"]);
  db.close();
});

test("用户可删除本频道自己的全部 pending，其他用户与 playing 不受影响", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["CA1", "CA2"]);
  enqueueMany(db, "user-b", ["CB1"]);
  const playing = claimNextQueueItem(db, { channelId: "cs2", now: 1_000 });
  assert.equal(playing.queueItem.song_name, "CA1");

  const result = cancelPendingItemsForPrincipalInChannel(db, {
    channelId: "cs2",
    principalKey: "user-a",
    now: 2_000,
  });
  assert.equal(result.cancelledCount, 1);
  assert.deepEqual(
    db.prepare("SELECT song_name, status FROM music_queue_items ORDER BY id").all(),
    [
      { song_name: "CA1", status: "playing" },
      { song_name: "CA2", status: "cancelled" },
      { song_name: "CB1", status: "pending" },
    ]
  );
  db.close();
});

test("管理员清空频道只取消 pending，其他频道和当前 playing 保留", () => {
  const db = createDb();
  enqueueMany(db, "user-a", ["QA1", "QA2"]);
  enqueueMany(db, "user-b", ["QB1"], "apex");
  const playing = claimNextQueueItem(db, { channelId: "cs2", now: 1_000 });
  assert.equal(playing.queueItem.song_name, "QA1");

  const result = clearPendingQueue(db, { channelId: "cs2", now: 2_000 });
  assert.equal(result.cancelledCount, 1);
  assert.deepEqual(
    db.prepare("SELECT song_name, status FROM music_queue_items ORDER BY id").all(),
    [
      { song_name: "QA1", status: "playing" },
      { song_name: "QA2", status: "cancelled" },
      { song_name: "QB1", status: "pending" },
    ]
  );
  db.close();
});
