// 频道音乐队列服务：持久化、按用户分桶、公平轮询。
//
// 身份铁律：principalKey 只能来自 req.authUser.id（服务端认证），
// 同一 NovaSpeak 用户的所有标签页 / 窗口 / 语音连接共用一个桶；
// 绝不使用前端 userId、网易云 uid、LiveKit participantIdentity、
// voiceConnectionId、昵称或 IP。
//
// 所有写操作都在 better-sqlite3 事务中执行（嵌套调用自动降级为 savepoint）。

import { projectFairQueue } from "./music-queue-scheduler.js";
import { randomInt } from "node:crypto";

export const USER_QUEUE_LIMIT = 50;
export const CHANNEL_QUEUE_LIMIT = 500;

export const MUSIC_QUEUE_ERROR = Object.freeze({
  USER_LIMIT: "MUSIC_USER_QUEUE_LIMIT",
  CHANNEL_LIMIT: "MUSIC_CHANNEL_QUEUE_LIMIT",
  TRACK_UNAVAILABLE: "MUSIC_TRACK_UNAVAILABLE",
  TRACK_NOT_FOUND: "MUSIC_TRACK_NOT_FOUND",
  ITEM_NOT_FOUND: "MUSIC_QUEUE_ITEM_NOT_FOUND",
  FORBIDDEN: "MUSIC_QUEUE_FORBIDDEN",
  NOT_IN_CHANNEL: "MUSIC_NOT_IN_CHANNEL",
  CHANNEL_NOT_FOUND: "MUSIC_CHANNEL_NOT_FOUND",
  EMPTY: "MUSIC_QUEUE_EMPTY",
});

export class MusicQueueError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "MusicQueueError";
    this.code = code;
    this.status = status;
  }
}

const ACTIVE_STATUSES = "('pending', 'playing')";

function ensureChannel(db, channelId) {
  const channel = db
    .prepare("SELECT id, name FROM channels WHERE id = ?")
    .get(channelId);
  if (!channel) {
    throw new MusicQueueError(
      MUSIC_QUEUE_ERROR.CHANNEL_NOT_FOUND,
      "频道不存在",
      404
    );
  }
  return channel;
}

function countActiveForUser(db, channelId, principalKey) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM music_queue_items
       WHERE channel_id = ? AND principal_key = ? AND status IN ${ACTIVE_STATUSES}`
    )
    .get(channelId, principalKey).count;
}

function countActiveForChannel(db, channelId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count FROM music_queue_items
       WHERE channel_id = ? AND status IN ${ACTIVE_STATUSES}`
    )
    .get(channelId).count;
}

function getOrCreateBucket(db, channelId, principalKey, now) {
  const existing = db
    .prepare(
      "SELECT bucket_order FROM music_queue_buckets WHERE channel_id = ? AND principal_key = ?"
    )
    .get(channelId, principalKey);
  if (existing) return existing.bucket_order;

  const nextOrder =
    db
      .prepare(
        "SELECT COALESCE(MAX(bucket_order), 0) + 1 AS next FROM music_queue_buckets WHERE channel_id = ?"
      )
      .get(channelId).next;
  db.prepare(
    "INSERT INTO music_queue_buckets (channel_id, principal_key, bucket_order, created_at) VALUES (?, ?, ?, ?)"
  ).run(channelId, principalKey, nextOrder, now);
  return nextOrder;
}

function getQueueState(db, channelId) {
  return (
    db
      .prepare(
        "SELECT last_served_bucket_order, revision FROM music_queue_state WHERE channel_id = ?"
      )
      .get(channelId) || { last_served_bucket_order: 0, revision: 0 }
  );
}

function bumpRevision(db, channelId, now) {
  db.prepare(`
    INSERT INTO music_queue_state (channel_id, last_served_bucket_order, revision, updated_at)
    VALUES (?, 0, 1, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      revision = revision + 1,
      updated_at = excluded.updated_at
  `).run(channelId, now);
  return getQueueState(db, channelId).revision;
}

function listBuckets(db, channelId) {
  return db
    .prepare(
      "SELECT principal_key AS principalKey, bucket_order AS bucketOrder FROM music_queue_buckets WHERE channel_id = ?"
    )
    .all(channelId);
}

function listPendingRows(db, channelId) {
  return db
    .prepare(
      `SELECT * FROM music_queue_items
       WHERE channel_id = ? AND status = 'pending'
       ORDER BY priority_order DESC, queue_order, id`
    )
    .all(channelId);
}

function projectPendingRows(db, channelId, state = getQueueState(db, channelId)) {
  const rows = listPendingRows(db, channelId);
  const prioritized = rows
    .filter((row) => Number(row.priority_order) > 0)
    .sort(
      (a, b) =>
        Number(b.priority_order) - Number(a.priority_order) || a.id - b.id
    );
  const normal = rows.filter((row) => Number(row.priority_order) <= 0);
  const fair = projectFairQueue({
    buckets: listBuckets(db, channelId),
    pendingItems: normal.map((row) => ({
      id: row.id,
      principalKey: row.principal_key,
      queueOrder: row.queue_order,
      row,
    })),
    lastServedBucketOrder: state.last_served_bucket_order,
  });
  return {
    rows,
    ordered: [
      ...prioritized.map((row) => ({
        id: row.id,
        principalKey: row.principal_key,
        queueOrder: row.queue_order,
        row,
        prioritized: true,
      })),
      ...fair,
    ],
  };
}

/**
 * 计算当前用户在频道内还能添加多少首（用户上限与频道上限的较小值）。
 */
export function getRemainingQueueCapacity(db, channelId, principalKey) {
  const userRemaining =
    USER_QUEUE_LIMIT - countActiveForUser(db, channelId, principalKey);
  const channelRemaining =
    CHANNEL_QUEUE_LIMIT - countActiveForChannel(db, channelId);
  return {
    userRemaining: Math.max(0, userRemaining),
    channelRemaining: Math.max(0, channelRemaining),
    remaining: Math.max(0, Math.min(userRemaining, channelRemaining)),
  };
}

/**
 * 入队（单曲或批量，同一事务）。tracks 为服务端标准化后的歌曲对象
 * （{id, name, artists, album, durationMs, fee, trackIndex?}），
 * 绝不接受前端提交的展示元数据。
 */
export function enqueueTracks(
  db,
  {
    channelId,
    principalKey,
    requesterDisplayName,
    tracks,
    playlistId = null,
    now = Date.now(),
  }
) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new MusicQueueError(
      MUSIC_QUEUE_ERROR.TRACK_UNAVAILABLE,
      "没有可添加的歌曲",
      409
    );
  }

  return db.transaction(() => {
    ensureChannel(db, channelId);

    const capacity = getRemainingQueueCapacity(db, channelId, principalKey);
    if (capacity.userRemaining <= 0) {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.USER_LIMIT,
        `每人最多同时排队 ${USER_QUEUE_LIMIT} 首歌曲`,
        409
      );
    }
    if (capacity.channelRemaining <= 0) {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.CHANNEL_LIMIT,
        `频道队列已满（上限 ${CHANNEL_QUEUE_LIMIT} 首）`,
        409
      );
    }

    const toAdd = tracks.slice(0, capacity.remaining);
    getOrCreateBucket(db, channelId, principalKey, now);
    let nextQueueOrder =
      db
        .prepare(
          `SELECT COALESCE(MAX(queue_order), 0) + 1 AS next
           FROM music_queue_items
           WHERE channel_id = ? AND principal_key = ?`
        )
        .get(channelId, principalKey).next;

    const insert = db.prepare(`
      INSERT INTO music_queue_items (
        channel_id, principal_key, requester_display_name,
        song_id, song_name, artists_json,
        album_id, album_name, cover_url,
        duration_ms, fee, playlist_id, playlist_track_index,
        status, added_at, queue_order, priority_order
      ) VALUES (
        @channelId, @principalKey, @requesterDisplayName,
        @songId, @songName, @artistsJson,
        @albumId, @albumName, @coverUrl,
        @durationMs, @fee, @playlistId, @playlistTrackIndex,
        'pending', @addedAt, @queueOrder, 0
      )
    `);

    const queueItemIds = [];
    for (const track of toAdd) {
      const result = insert.run({
        channelId,
        principalKey,
        requesterDisplayName:
          typeof requesterDisplayName === "string" && requesterDisplayName.trim()
            ? requesterDisplayName.trim()
            : "未知成员",
        songId: track.id,
        songName: track.name,
        artistsJson: JSON.stringify(track.artists || []),
        albumId: track.album?.id ?? null,
        albumName: track.album?.name ?? null,
        coverUrl: track.album?.picUrl ?? null,
        durationMs: track.durationMs ?? 0,
        fee: track.fee ?? 0,
        playlistId,
        playlistTrackIndex:
          Number.isInteger(track.trackIndex) && track.trackIndex >= 0
            ? track.trackIndex
            : null,
        addedAt: now,
        queueOrder: nextQueueOrder++,
      });
      queueItemIds.push(String(result.lastInsertRowid));
    }

    const revision = bumpRevision(db, channelId, now);

    return {
      addedCount: toAdd.length,
      truncated: toAdd.length < tracks.length,
      queueItemIds,
      revision,
    };
  })();
}

function toPublicSong(row) {
  let artists = [];
  try {
    const parsed = JSON.parse(row.artists_json);
    if (Array.isArray(parsed)) artists = parsed;
  } catch {
    artists = [];
  }
  return {
    id: row.song_id,
    name: row.song_name,
    artists,
    album: row.album_name
      ? { id: row.album_id, name: row.album_name, picUrl: row.cover_url }
      : null,
    durationMs: row.duration_ms,
    fee: row.fee ?? 0,
  };
}

// 对外队列项：绝不暴露 principal_key / guest UUID / 数据库用户 ID
function toPublicQueueItem(row, viewer, projectedPosition) {
  const isCurrentUser = row.principal_key === viewer.principalKey;
  return {
    id: String(row.id),
    status: row.status,
    projectedPosition,
    song: toPublicSong(row),
    requester: {
      displayName: row.requester_display_name,
      isCurrentUser,
    },
    addedAt: row.added_at,
    canCancel:
      row.status === "pending" && (isCurrentUser || viewer.isAdmin === true),
    prioritized: Number(row.priority_order) > 0,
  };
}

function toPublicNowPlaying(row, viewer, now) {
  const durationMs = Math.max(0, Number(row.duration_ms) || 0);
  const startedAt = Number.isSafeInteger(row.started_at)
    ? row.started_at
    : null;
  const elapsedMs = startedAt === null
    ? 0
    : Math.min(durationMs, Math.max(0, now - startedAt));

  return {
    ...toPublicQueueItem(row, viewer, 0),
    playback: {
      startedAt,
      elapsedMs,
      durationMs,
      paused: false,
    },
  };
}

/**
 * 当前频道共享队列快照，items 按预计公平播放顺序返回。
 */
export function getQueueSnapshot(db, { channelId, viewer, now = Date.now() }) {
  const channel = ensureChannel(db, channelId);
  const state = getQueueState(db, channelId);
  const { rows: pendingRows, ordered } = projectPendingRows(
    db,
    channelId,
    state
  );

  const playingRow = db
    .prepare(
      "SELECT * FROM music_queue_items WHERE channel_id = ? AND status = 'playing'"
    )
    .get(channelId);

  return {
    channelId: channel.id,
    nowPlaying: playingRow
      ? toPublicNowPlaying(playingRow, viewer, now)
      : null,
    items: ordered.map((entry, index) =>
      toPublicQueueItem(entry.row, viewer, index + 1)
    ),
    totalPending: pendingRows.length,
    revision: state.revision,
  };
}

/**
 * 随机打乱每个用户桶内部的普通 pending 歌曲。
 * 用户桶本身与公平游标均不改变，因此 A/B 仍严格动态交替；显式置顶歌曲
 * 保持在队首，不会被一次随机操作取消其优先语义。
 */
export function shufflePendingQueue(
  db,
  { channelId, randomIndex = (maxExclusive) => randomInt(maxExclusive), now = Date.now() }
) {
  return db.transaction(() => {
    ensureChannel(db, channelId);
    const rows = db
      .prepare(
        `SELECT id, principal_key, queue_order
         FROM music_queue_items
         WHERE channel_id = ? AND status = 'pending' AND priority_order = 0
         ORDER BY principal_key, queue_order, id`
      )
      .all(channelId);
    if (rows.length === 0) {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.EMPTY,
        "当前没有可随机排序的待播放歌曲",
        409
      );
    }

    const byPrincipal = new Map();
    for (const row of rows) {
      if (!byPrincipal.has(row.principal_key)) {
        byPrincipal.set(row.principal_key, []);
      }
      byPrincipal.get(row.principal_key).push(row);
    }

    const update = db.prepare(
      "UPDATE music_queue_items SET queue_order = ? WHERE id = ? AND status = 'pending'"
    );
    let shuffledCount = 0;
    for (const bucketRows of byPrincipal.values()) {
      if (bucketRows.length < 2) continue;
      const orderSlots = bucketRows.map((row) => row.queue_order);
      const shuffled = [...bucketRows];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const picked = Number(randomIndex(index + 1));
        const safePicked = Number.isInteger(picked) && picked >= 0 && picked <= index
          ? picked
          : 0;
        [shuffled[index], shuffled[safePicked]] = [
          shuffled[safePicked],
          shuffled[index],
        ];
      }
      shuffled.forEach((row, index) => update.run(orderSlots[index], row.id));
      shuffledCount += shuffled.length;
    }

    return {
      shuffledCount,
      revision: bumpRevision(db, channelId, now),
    };
  })();
}

/**
 * 把指定 pending 歌曲置为全频道下一首。后置顶者优先；claim 该歌曲时不
 * 推进公平游标，播放结束后从置顶前的用户轮询位置继续。
 */
export function prioritizeQueueItem(
  db,
  { channelId, queueItemId, now = Date.now() }
) {
  return db.transaction(() => {
    ensureChannel(db, channelId);
    const row = db
      .prepare(
        "SELECT id, status FROM music_queue_items WHERE channel_id = ? AND id = ?"
      )
      .get(channelId, queueItemId);
    if (!row || row.status !== "pending") {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND,
        "该歌曲已不在待播放队列中",
        404
      );
    }
    const nextPriority = db
      .prepare(
        `SELECT COALESCE(MAX(priority_order), 0) + 1 AS next
         FROM music_queue_items WHERE channel_id = ?`
      )
      .get(channelId).next;
    db.prepare(
      `UPDATE music_queue_items SET priority_order = ?
       WHERE channel_id = ? AND id = ? AND status = 'pending'`
    ).run(nextPriority, channelId, queueItemId);
    return { revision: bumpRevision(db, channelId, now) };
  })();
}

/**
 * 第一帧真正进入 LiveKit 时校准播放开始时间。claim 的 started_at 只代表
 * worker 领取时间，可能包含取 URL、连接 CDN 和启动 FFmpeg 的等待时间。
 */
export function markQueueItemPlaybackStarted(
  db,
  { queueItemId, now = Date.now() }
) {
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT id, channel_id FROM music_queue_items WHERE id = ? AND status = 'playing'"
      )
      .get(queueItemId);
    if (!row) return null;

    db.prepare(
      "UPDATE music_queue_items SET started_at = ? WHERE id = ? AND status = 'playing'"
    ).run(now, queueItemId);

    return {
      startedAt: now,
      revision: bumpRevision(db, row.channel_id, now),
    };
  })();
}

/**
 * 取消单个 pending 项目：本人或 admin。
 */
export function cancelQueueItem(
  db,
  { channelId, queueItemId, principalKey, isAdmin = false, now = Date.now() }
) {
  return db.transaction(() => {
    ensureChannel(db, channelId);
    const row = db
      .prepare(
        "SELECT id, principal_key, status FROM music_queue_items WHERE id = ? AND channel_id = ?"
      )
      .get(queueItemId, channelId);
    if (!row || row.status !== "pending") {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND,
        "该歌曲已不在待播放队列中",
        404
      );
    }
    if (row.principal_key !== principalKey && !isAdmin) {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.FORBIDDEN,
        "只能取消自己点的歌曲",
        403
      );
    }
    db.prepare(
      "UPDATE music_queue_items SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'"
    ).run(now, row.id);
    const revision = bumpRevision(db, channelId, now);
    return { revision };
  })();
}

/**
 * 取消指定 principal 的所有 pending 项目（跨频道）。
 * 用于解绑网易云账号——下一阶段无法再用该账号取得播放 URL。
 */
export function cancelPendingItemsForPrincipal(db, principalKey, now = Date.now()) {
  return db.transaction(() => {
    const channels = db
      .prepare(
        "SELECT DISTINCT channel_id AS channelId FROM music_queue_items WHERE principal_key = ? AND status = 'pending'"
      )
      .all(principalKey);
    const changed = db
      .prepare(
        "UPDATE music_queue_items SET status = 'cancelled', finished_at = ? WHERE principal_key = ? AND status = 'pending'"
      )
      .run(now, principalKey).changes;
    for (const { channelId } of channels) {
      bumpRevision(db, channelId, now);
    }
    return changed;
  })();
}

/**
 * 是否存在待播放歌曲（manager 决定是否需要探测解码器 / claim）。
 */
export function hasPendingItems(db, channelId) {
  return (
    db
      .prepare(
        "SELECT 1 AS one FROM music_queue_items WHERE channel_id = ? AND status = 'pending' LIMIT 1"
      )
      .get(channelId) !== undefined
  );
}

/**
 * 所有存在 pending 歌曲的频道（manager 定时扫描用）。
 */
export function listChannelsWithPending(db) {
  return db
    .prepare(
      "SELECT DISTINCT channel_id AS channelId FROM music_queue_items WHERE status = 'pending'"
    )
    .all()
    .map((row) => row.channelId);
}

/**
 * 领取下一首。每频道最多一个 playing；公平选桶后在同一事务中完成
 * pending → playing、started_at、游标与 revision 更新。
 *
 * 返回内部 claim receipt：{ queueItem, previousLastServedBucketOrder,
 * servedBucketOrder }，供基础设施故障时 requeueClaimedItem 恢复
 * 原公平位置。receipt 绝不暴露给前端。
 */
export function claimNextQueueItem(db, { channelId, now = Date.now() }) {
  return db.transaction(() => {
    ensureChannel(db, channelId);

    const playing = db
      .prepare(
        "SELECT id FROM music_queue_items WHERE channel_id = ? AND status = 'playing'"
      )
      .get(channelId);
    if (playing) return null;

    const state = getQueueState(db, channelId);
    const { ordered } = projectPendingRows(db, channelId, state);
    if (ordered.length === 0) return null;

    const next = ordered[0].row;
    const claimed = db
      .prepare(
        "UPDATE music_queue_items SET status = 'playing', started_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(now, next.id).changes;
    if (claimed !== 1) return null;

    const bucketOrder = db
      .prepare(
        "SELECT bucket_order FROM music_queue_buckets WHERE channel_id = ? AND principal_key = ?"
      )
      .get(channelId, next.principal_key)?.bucket_order;

    const isPriorityClaim = Number(next.priority_order) > 0;
    if (isPriorityClaim) {
      // 置顶是一次临时抢占，不消费用户桶轮次。
      bumpRevision(db, channelId, now);
    } else {
      db.prepare(`
        INSERT INTO music_queue_state (channel_id, last_served_bucket_order, revision, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          last_served_bucket_order = excluded.last_served_bucket_order,
          revision = revision + 1,
          updated_at = excluded.updated_at
      `).run(channelId, bucketOrder ?? 0, now);
    }

    return {
      queueItem: db
        .prepare("SELECT * FROM music_queue_items WHERE id = ?")
        .get(next.id),
      previousLastServedBucketOrder: state.last_served_bucket_order,
      servedBucketOrder: bucketOrder ?? 0,
      priorityClaim: isPriorityClaim,
    };
  })();
}

/**
 * 基础设施故障回退：playing → pending、清空 started_at / failure_code，
 * 并把公平游标恢复到 claim 之前的值——A1 因 FFmpeg/LiveKit 暂时失败
 * 恢复后仍然是 A1，不会无故轮到 B1。
 */
export function requeueClaimedItem(
  db,
  { queueItemId, previousLastServedBucketOrder, now = Date.now() }
) {
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT id, channel_id, status FROM music_queue_items WHERE id = ?"
      )
      .get(queueItemId);
    if (!row || row.status !== "playing") return false;

    db.prepare(
      "UPDATE music_queue_items SET status = 'pending', started_at = NULL, failure_code = NULL WHERE id = ? AND status = 'playing'"
    ).run(row.id);

    db.prepare(`
      INSERT INTO music_queue_state (channel_id, last_served_bucket_order, revision, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_served_bucket_order = excluded.last_served_bucket_order,
        revision = revision + 1,
        updated_at = excluded.updated_at
    `).run(
      row.channel_id,
      Number.isFinite(Number(previousLastServedBucketOrder))
        ? Number(previousLastServedBucketOrder)
        : 0,
      now
    );
    return true;
  })();
}

const FINISH_OUTCOMES = new Set(["finished", "skipped", "failed"]);

/**
 * 结束当前 playing 项目（内部使用，不暴露给客户端直接调用）。
 */
export function finishQueueItem(
  db,
  { queueItemId, outcome, failureCode = null, now = Date.now() }
) {
  if (!FINISH_OUTCOMES.has(outcome)) {
    throw new MusicQueueError(
      MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND,
      "无效的结束状态",
      400
    );
  }
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT id, channel_id, status FROM music_queue_items WHERE id = ?"
      )
      .get(queueItemId);
    if (!row || row.status !== "playing") {
      throw new MusicQueueError(
        MUSIC_QUEUE_ERROR.ITEM_NOT_FOUND,
        "该歌曲不在播放中",
        409
      );
    }
    db.prepare(
      "UPDATE music_queue_items SET status = ?, finished_at = ?, failure_code = ? WHERE id = ? AND status = 'playing'"
    ).run(outcome, now, failureCode, row.id);
    const revision = bumpRevision(db, row.channel_id, now);
    return { revision };
  })();
}

/**
 * 服务重启恢复：把异常退出留下的 playing 恢复为 pending。
 * 可重复执行；本阶段不在运行中自动 claim。
 */
export function recoverInterruptedQueueItems(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT id, channel_id FROM music_queue_items WHERE status = 'playing'"
      )
      .all();
    if (rows.length === 0) return 0;
    db.prepare(
      "UPDATE music_queue_items SET status = 'pending', started_at = NULL WHERE status = 'playing'"
    ).run();
    for (const channelId of new Set(rows.map((row) => row.channel_id))) {
      bumpRevision(db, channelId, now);
    }
    return rows.length;
  })();
}

/**
 * 管理员删除正式成员时清理其队列数据：
 * 删除 pending 项目和用户桶（与成员删除同一外层事务，
 * better-sqlite3 嵌套事务自动降级为 savepoint）。
 */
export function removeQueueDataForPrincipal(db, principalKey, now = Date.now()) {
  return db.transaction(() => {
    const channels = db
      .prepare(
        "SELECT DISTINCT channel_id AS channelId FROM music_queue_items WHERE principal_key = ? AND status = 'pending'"
      )
      .all(principalKey);
    db.prepare(
      "DELETE FROM music_queue_items WHERE principal_key = ? AND status = 'pending'"
    ).run(principalKey);
    db.prepare(
      "DELETE FROM music_queue_buckets WHERE principal_key = ?"
    ).run(principalKey);
    for (const { channelId } of channels) {
      bumpRevision(db, channelId, now);
    }
  })();
}
