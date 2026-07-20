import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { backupBeforeChatMigration, migrateChatMessages } from "./migrate.js";

test("既有数据库首次聊天迁移前备份，重复迁移不重复备份", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-chat-"));
  try {
    const databasePath = path.join(root, "novaspeak.db");
    let db = new Database(databasePath);
    db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    db.prepare("INSERT INTO channels VALUES ('lobby', '大厅')").run();
    db.close();

    db = new Database(databasePath);
    const first = await backupBeforeChatMigration(db, {
      databasePath,
      preExistingDatabase: true,
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    assert.equal(first.backedUp, true);
    assert.equal(path.basename(first.backupPath), "novaspeak-before-chat-history-20260102T030405.db");
    assert.equal(fs.existsSync(first.backupPath), true);
    const backupDb = new Database(first.backupPath, { readonly: true });
    assert.equal(backupDb.prepare("SELECT COUNT(*) AS count FROM channels").get().count, 1);
    assert.equal(backupDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'channel_messages'").get(), undefined);
    backupDb.close();

    migrateChatMessages(db);
    const second = await backupBeforeChatMigration(db, {
      databasePath,
      preExistingDatabase: true,
    });
    assert.deepEqual(second, { backedUp: false, reason: "already-migrated" });
    assert.equal(fs.readdirSync(path.join(root, "backups")).length, 1);
    db.close();
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("全新数据库不创建迁移备份", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-chat-new-"));
  try {
    const databasePath = path.join(root, "novaspeak.db");
    const db = new Database(databasePath);
    db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    const result = await backupBeforeChatMigration(db, {
      databasePath,
      preExistingDatabase: false,
    });
    assert.deepEqual(result, { backedUp: false, reason: "new-database" });
    migrateChatMessages(db);
    assert.equal(fs.existsSync(path.join(root, "backups")), false);
    db.close();
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("既有聊天表增加附件字段前单独备份，迁移可重复", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-chat-attachments-"));
  try {
    const databasePath = path.join(root, "novaspeak.db");
    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE channel_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        sender_principal_key TEXT NOT NULL,
        sender_display_name TEXT NOT NULL,
        message_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const backup = await backupBeforeChatMigration(db, {
      databasePath,
      preExistingDatabase: true,
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    assert.equal(path.basename(backup.backupPath), "novaspeak-before-chat-attachments-20260102T030405.db");
    migrateChatMessages(db);
    migrateChatMessages(db);
    const columns = new Set(db.prepare("PRAGMA table_info(channel_messages)").all().map((column) => column.name));
    assert.equal(columns.has("attachment_storage_name"), true);
    assert.deepEqual(await backupBeforeChatMigration(db, { databasePath, preExistingDatabase: true }), { backedUp: false, reason: "already-migrated" });
    db.close();
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("聊天迁移备份失败时中止且不创建表", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-chat-fail-"));
  try {
    const databasePath = path.join(root, "novaspeak.db");
    const db = new Database(databasePath);
    db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    fs.writeFileSync(path.join(root, "backups"), "not-a-directory");
    let migrated = false;
    await assert.rejects(async () => {
      await backupBeforeChatMigration(db, {
        databasePath,
        preExistingDatabase: true,
      });
      migrateChatMessages(db);
      migrated = true;
    });
    assert.equal(migrated, false);
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'channel_messages'").get(),
      undefined
    );
    db.close();
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
