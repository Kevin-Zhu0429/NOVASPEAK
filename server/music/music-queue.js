// 频道音乐队列服务：持久化、按用户分桶、公平轮询。
//
// 身份铁律：principalKey 只能来自 req.authUser.id（服务端认证），
// 同一 NovaSpeak 用户的所有标签页 / 窗口 / 语音连接共用一个桶；
// 绝不使用前端 userId、网易云 uid、LiveKit participantIdentity、
// voiceConnectionId、昵称或 IP。
//
// 所有写操作都在 better-sqlite3 事务中执行（嵌套调用自动降级为 savepoint）。

import { projectFairQueue } from "./music-queue-scheduler.js";

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
      "SELECT * FROM music_queue_items WHERE channel_id = ? AND status = 'pending' ORDER BY id"
    )
    .all(channelId);
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

    const insert = db.prepare(`
      INSERT INTO music_queue_items (
        channel_id, principal_key, requester_display_name,
        song_id, song_name, artists_json,
        album_id, album_name, cover_url,
        duration_ms, fee, playlist_id, playlist_track_index,
        status, added_at
      ) VALUES (
        @channelId, @principalKey, @requesterDisplayName,
        @songId, @songName, @artistsJson,
        @albumId, @albumName, @coverUrl,
        @durationMs, @fee, @playlistId, @playlistTrackIndex,
        'pending', @addedAt
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
    startedAt: row.started_at ?? null,
    canCancel:
      row.status === "pending" && (isCurrentUser || viewer.isAdmin === true),
  };
}

/**
 * 当前频道共享队列快照，items 按预计公平播放顺序返回。
 */
export function getQueueSnapshot(db, { channelId, viewer }) {
  const channel = ensureChannel(db, channelId);
  const state = getQueueState(db, channelId);
  const pendingRows = listPendingRows(db, channelId);
  const buckets = listBuckets(db, channelId);

  const ordered = projectFairQueue({
    buckets,
    pendingItems: pendingRows.map((row) => ({
      id: row.id,
      principalKey: row.principal_key,
      row,
    })),
    lastServedBucketOrder: state.last_served_bucket_order,
  });

  const playingRow = db
    .prepare(
      "SELECT * FROM music_queue_items WHERE channel_id = ? AND status = 'playing'"
    )
    .get(channelId);

  return {
    channelId: channel.id,
    nowPlaying: playingRow
      ? toPublicQueueItem(playingRow, viewer, 0)
      : null,
    items: ordered.map((entry, index) =>
      toPublicQueueItem(entry.row, viewer, index + 1)
    ),
    totalPending: pendingRows.length,
    revision: state.revision,
  };
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
 * 领取下一首（供下一阶段机器人调用；本阶段不在运行中自动消费）。
 * 每频道最多一个 playing；公平选桶后在同一事务中完成
 * pending → playing、started_at、游标与 revision 更新。
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
    const ordered = projectFairQueue({
      buckets: listBuckets(db, channelId),
      pendingItems: listPendingRows(db, channelId).map((row) => ({
        id: row.id,
        principalKey: row.principal_key,
        row,
      })),
      lastServedBucketOrder: state.last_served_bucket_order,
    });
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

    db.prepare(`
      INSERT INTO music_queue_state (channel_id, last_served_bucket_order, revision, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        last_served_bucket_order = excluded.last_served_bucket_order,
        revision = revision + 1,
        updated_at = excluded.updated_at
    `).run(channelId, bucketOrder ?? 0, now);

    return db
      .prepare("SELECT * FROM music_queue_items WHERE id = ?")
      .get(next.id);
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

export function listPendingMusicChannelIds(db) {
  return db
    .prepare("SELECT DISTINCT channel_id AS channelId FROM music_queue_items WHERE status = 'pending' ORDER BY channel_id")
    .all()
    .map((row) => row.channelId);
}

export function requeuePlayingQueueItem(db, { queueItemId, now = Date.now() }) {
  return db.transaction(() => {
    const row = db.prepare("SELECT id, channel_id, status FROM music_queue_items WHERE id = ?").get(queueItemId);
    if (!row || row.status !== "playing") return { changed: false, revision: null };
    db.prepare("UPDATE music_queue_items SET status = 'pending', started_at = NULL, failure_code = NULL WHERE id = ? AND status = 'playing'").run(row.id);
    const revision = bumpRevision(db, row.channel_id, now);
    return { changed: true, revision };
  })();
}
