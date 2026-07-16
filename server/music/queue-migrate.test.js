import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  backupBeforeMusicQueueMigration,
  migrateMusicQueue,
  musicQueueTablesExist,
} from "./queue-migrate.js";

// 全部使用临时数据库，绝不触碰真实数据

async function makeTempDir() {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-queue-mig-"));
}

function createBaseDatabase(databasePath) {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO channels (id, name) VALUES (?, ?)").run("cs2", "CS2");
  return db;
}

test("新数据库迁移：三张表和索引存在，且不备份", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    const preExistingDatabase = fs.existsSync(databasePath);
    const db = createBaseDatabase(databasePath);

    const backup = await backupBeforeMusicQueueMigration(db, {
      databasePath,
      preExistingDatabase,
    });
    assert.equal(backup.backedUp, false);
    assert.equal(backup.reason, "new-database");

    migrateMusicQueue(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'music_queue%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      "music_queue_buckets",
      "music_queue_items",
      "music_queue_state",
    ]);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'music_queue_items%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes("music_queue_items_channel_status_index"));
    assert.ok(indexes.includes("music_queue_items_principal_index"));
    assert.ok(indexes.includes("music_queue_items_single_playing_index"));

    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("既有数据库首次队列迁移前产生备份，重复启动不再备份", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    let db = createBaseDatabase(databasePath);
    db.close();

    // 第一次启动：文件已存在且非空 → 备份 + 迁移
    db = new Database(databasePath);
    const first = await backupBeforeMusicQueueMigration(db, {
      databasePath,
      preExistingDatabase: true,
    });
    assert.equal(first.backedUp, true);
    assert.match(
      path.basename(first.backupPath),
      /^novaspeak-before-music-queue-\d{8}T\d{6}\.db$/
    );
    assert.ok(fs.existsSync(first.backupPath));

    // 备份内容完整且不含队列表
    const backupDb = new Database(first.backupPath, { readonly: true });
    assert.equal(
      backupDb.prepare("SELECT COUNT(*) AS count FROM channels").get().count,
      1
    );
    assert.equal(musicQueueTablesExist(backupDb), false);
    backupDb.close();

    migrateMusicQueue(db);
    db.close();

    // 第二次启动：不再备份
    db = new Database(databasePath);
    const second = await backupBeforeMusicQueueMigration(db, {
      databasePath,
      preExistingDatabase: true,
    });
    assert.equal(second.backedUp, false);
    assert.equal(second.reason, "already-migrated");
    migrateMusicQueue(db);
    db.close();

    // 只统计备份主文件；-wal/-shm 是测试自己只读打开备份产生的边车文件
    const backupFiles = fs
      .readdirSync(path.join(tempRoot, "backups"))
      .filter((name) => /^novaspeak-before-music-queue-.*\.db$/.test(name));
    assert.equal(backupFiles.length, 1);
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("备份失败阻止迁移", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    let db = createBaseDatabase(databasePath);
    db.close();

    fs.writeFileSync(path.join(tempRoot, "backups"), "not a directory");

    db = new Database(databasePath);
    let migrated = false;
    await assert.rejects(async () => {
      await backupBeforeMusicQueueMigration(db, {
        databasePath,
        preExistingDatabase: true,
      });
      migrated = true;
      migrateMusicQueue(db);
    });
    assert.equal(migrated, false);
    assert.equal(musicQueueTablesExist(db), false);
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("迁移可重复执行且保留数据", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    const db = createBaseDatabase(databasePath);
    migrateMusicQueue(db);

    db.prepare(
      "INSERT INTO music_queue_buckets (channel_id, principal_key, bucket_order, created_at) VALUES (?, ?, ?, ?)"
    ).run("cs2", "user-a", 1, Date.now());

    migrateMusicQueue(db);
    migrateMusicQueue(db);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM music_queue_buckets").get().count,
      1
    );
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("频道删除级联清理队列数据", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    const db = createBaseDatabase(databasePath);
    migrateMusicQueue(db);

    const now = Date.now();
    db.prepare(
      "INSERT INTO music_queue_buckets (channel_id, principal_key, bucket_order, created_at) VALUES (?, ?, ?, ?)"
    ).run("cs2", "user-a", 1, now);
    db.prepare(
      "INSERT INTO music_queue_state (channel_id, last_served_bucket_order, revision, updated_at) VALUES (?, 0, 1, ?)"
    ).run("cs2", now);
    db.prepare(`
      INSERT INTO music_queue_items (
        channel_id, principal_key, requester_display_name,
        song_id, song_name, artists_json, duration_ms, status, added_at
      ) VALUES ('cs2', 'user-a', 'A', '1', '歌', '[]', 1000, 'pending', ?)
    `).run(now);

    db.prepare("DELETE FROM channels WHERE id = 'cs2'").run();

    for (const table of ["music_queue_buckets", "music_queue_state", "music_queue_items"]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
        0,
        table
      );
    }
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("每频道最多一个 playing 项目（partial unique index）", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    const db = createBaseDatabase(databasePath);
    migrateMusicQueue(db);
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO music_queue_items (
        channel_id, principal_key, requester_display_name,
        song_id, song_name, artists_json, duration_ms, status, added_at
      ) VALUES ('cs2', 'user-a', 'A', ?, '歌', '[]', 1000, 'playing', ?)
    `);
    insert.run("1", now);
    assert.throws(() => insert.run("2", now), /UNIQUE/);
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});
