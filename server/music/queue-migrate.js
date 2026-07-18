// 频道音乐队列持久化表迁移 + 首次迁移前备份。
//
// 三张表：
// - music_queue_buckets：频道内用户桶及稳定 bucket_order；
// - music_queue_state：频道游标 last_served_bucket_order 与 revision；
// - music_queue_items：队列项（含标准化歌曲元数据快照）。
//
// principal_key 刻意不建 users 外键（guest:UUID 不在 users 表），
// channel_id 外键关联 channels(id) ON DELETE CASCADE，
// 频道删除时自动级联清理队列数据。迁移可重复执行。

import fs from "node:fs";
import path from "node:path";

export const MUSIC_QUEUE_STATUSES = Object.freeze([
  "pending",
  "playing",
  "finished",
  "skipped",
  "failed",
  "cancelled",
]);

export function musicQueueTablesExist(db) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'music_queue_items'"
      )
      .get()
  );
}

export function musicQueueOrderingColumnsExist(db) {
  if (!musicQueueTablesExist(db)) return false;
  const columns = db.prepare("PRAGMA table_info(music_queue_items)").all();
  const names = new Set(columns.map((column) => column.name));
  return names.has("queue_order") && names.has("priority_order");
}

/**
 * 首次执行队列迁移前备份数据库（与网易云迁移备份同一策略）：
 * 仅当数据库启动前已存在且非空、且队列表尚不存在时备份；
 * 使用 better-sqlite3 在线 backup API（WAL 安全）；
 * 备份失败抛出异常，调用方必须让启动失败，不得继续迁移。
 */
export async function backupBeforeMusicQueueMigration(
  db,
  { databasePath, preExistingDatabase, now = new Date() }
) {
  if (!preExistingDatabase) {
    return { backedUp: false, reason: "new-database" };
  }
  if (musicQueueTablesExist(db)) {
    return { backedUp: false, reason: "already-migrated" };
  }

  const backupsDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });

  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "");
  const backupPath = path.join(
    backupsDirectory,
    `novaspeak-before-music-queue-${stamp}.db`
  );

  await db.backup(backupPath);

  return { backedUp: true, backupPath };
}

/**
 * 既有 5A 队列升级为可洗牌 / 可置顶结构前单独备份。
 * 首次创建队列表时由 backupBeforeMusicQueueMigration 负责备份，避免同次
 * 启动产生两份重复备份；字段已存在时可重复启动且不再备份。
 */
export async function backupBeforeMusicQueueOrderingMigration(
  db,
  { databasePath, preExistingDatabase, now = new Date() }
) {
  if (!preExistingDatabase) {
    return { backedUp: false, reason: "new-database" };
  }
  if (!musicQueueTablesExist(db)) {
    return { backedUp: false, reason: "queue-not-created" };
  }
  if (musicQueueOrderingColumnsExist(db)) {
    return { backedUp: false, reason: "already-migrated" };
  }

  const backupsDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "");
  const backupPath = path.join(
    backupsDirectory,
    `novaspeak-before-music-queue-ordering-${stamp}.db`
  );
  await db.backup(backupPath);
  return { backedUp: true, backupPath };
}

export function migrateMusicQueue(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS music_queue_buckets (
      channel_id TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      bucket_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,

      PRIMARY KEY (channel_id, principal_key),
      UNIQUE (channel_id, bucket_order),

      FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS music_queue_state (
      channel_id TEXT PRIMARY KEY,
      last_served_bucket_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,

      FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS music_queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      requester_display_name TEXT NOT NULL,

      song_id TEXT NOT NULL,
      song_name TEXT NOT NULL,
      artists_json TEXT NOT NULL,
      album_id TEXT,
      album_name TEXT,
      cover_url TEXT,
      duration_ms INTEGER NOT NULL,
      fee INTEGER,
      playlist_id TEXT,
      playlist_track_index INTEGER,

      status TEXT NOT NULL CHECK (
        status IN (
          'pending', 'playing', 'finished', 'skipped', 'failed', 'cancelled'
        )
      ),

      added_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      failure_code TEXT,
      queue_order INTEGER NOT NULL DEFAULT 0,
      priority_order INTEGER NOT NULL DEFAULT 0,

      FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS music_queue_items_channel_status_index
      ON music_queue_items(channel_id, status, id);

    CREATE INDEX IF NOT EXISTS music_queue_items_principal_index
      ON music_queue_items(channel_id, principal_key, status, id);

    CREATE UNIQUE INDEX IF NOT EXISTS music_queue_items_single_playing_index
      ON music_queue_items(channel_id)
      WHERE status = 'playing';
  `);

  // 从早期 5A 表结构升级。SQLite 的 ALTER TABLE ADD COLUMN 需要逐列判断，
  // 迁移可重复执行；旧数据以 id 回填，保持升级前的桶内 FIFO 顺序。
  const itemColumns = new Set(
    db.prepare("PRAGMA table_info(music_queue_items)").all().map((column) => column.name)
  );
  if (!itemColumns.has("queue_order")) {
    db.exec("ALTER TABLE music_queue_items ADD COLUMN queue_order INTEGER");
  }
  if (!itemColumns.has("priority_order")) {
    db.exec(
      "ALTER TABLE music_queue_items ADD COLUMN priority_order INTEGER NOT NULL DEFAULT 0"
    );
  }
  db.exec(`
    UPDATE music_queue_items
    SET queue_order = id
    WHERE queue_order IS NULL;

    CREATE INDEX IF NOT EXISTS music_queue_items_pending_order_index
      ON music_queue_items(
        channel_id, status, priority_order DESC,
        principal_key, queue_order, id
      );
  `);
}
