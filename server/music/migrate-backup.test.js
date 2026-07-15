import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  backupBeforeNeteaseMigration,
  migrateNeteaseAccounts,
  neteaseTableExists,
} from "./migrate.js";

// 全部使用临时数据库和临时备份目录，绝不触碰真实数据

async function makeTempDir() {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "novaspeak-backup-"));
}

function createLegacyDatabase(databasePath) {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE legacy_users (id TEXT PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO legacy_users (id, name) VALUES (?, ?)").run(
    "u1",
    "既有数据"
  );
  db.close();
}

function isPreExisting(databasePath) {
  return (
    fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0
  );
}

test("首次网易云迁移前对既有数据库产生在线备份", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    createLegacyDatabase(databasePath);

    const preExistingDatabase = isPreExisting(databasePath);
    assert.equal(preExistingDatabase, true);

    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");

    const result = await backupBeforeNeteaseMigration(db, {
      databasePath,
      preExistingDatabase,
    });
    assert.equal(result.backedUp, true);
    assert.match(
      path.basename(result.backupPath),
      /^novaspeak-before-netease-\d{8}T\d{6}\.db$/
    );
    assert.equal(
      path.dirname(result.backupPath),
      path.join(tempRoot, "backups")
    );
    assert.ok(fs.existsSync(result.backupPath));

    // 备份是打得开的完整 SQLite，包含迁移前数据、不含 netease 表
    const backupDb = new Database(result.backupPath, { readonly: true });
    const legacyRow = backupDb
      .prepare("SELECT name FROM legacy_users WHERE id = 'u1'")
      .get();
    assert.equal(legacyRow.name, "既有数据");
    assert.equal(neteaseTableExists(backupDb), false);
    backupDb.close();

    migrateNeteaseAccounts(db);
    assert.equal(neteaseTableExists(db), true);
    // 迁移后原有数据完好
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM legacy_users").get().count,
      1
    );
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("netease 表已存在时重复启动不再备份", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    createLegacyDatabase(databasePath);

    // 第一次启动：备份 + 迁移
    let db = new Database(databasePath);
    const first = await backupBeforeNeteaseMigration(db, {
      databasePath,
      preExistingDatabase: isPreExisting(databasePath),
    });
    assert.equal(first.backedUp, true);
    migrateNeteaseAccounts(db);
    db.close();

    // 第二次启动：不得重复备份
    db = new Database(databasePath);
    const second = await backupBeforeNeteaseMigration(db, {
      databasePath,
      preExistingDatabase: true,
    });
    assert.equal(second.backedUp, false);
    assert.equal(second.reason, "already-migrated");
    migrateNeteaseAccounts(db);
    db.close();

    const backupFiles = fs.readdirSync(path.join(tempRoot, "backups"));
    assert.equal(backupFiles.length, 1);
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("全新数据库首次创建时不备份空数据库", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    // 模拟 db.js：打开前文件不存在
    const preExistingDatabase = isPreExisting(databasePath);
    assert.equal(preExistingDatabase, false);

    const db = new Database(databasePath);
    const result = await backupBeforeNeteaseMigration(db, {
      databasePath,
      preExistingDatabase,
    });
    assert.equal(result.backedUp, false);
    assert.equal(result.reason, "new-database");
    migrateNeteaseAccounts(db);
    db.close();

    assert.equal(fs.existsSync(path.join(tempRoot, "backups")), false);
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test("备份失败时抛出异常且不得执行迁移", async () => {
  const tempRoot = await makeTempDir();
  try {
    const databasePath = path.join(tempRoot, "novaspeak.db");
    createLegacyDatabase(databasePath);

    // 用同名普通文件占住 backups 目录，使 mkdirSync 失败
    fs.writeFileSync(path.join(tempRoot, "backups"), "not a directory");

    const db = new Database(databasePath);

    // 模拟 db.js 的启动顺序：备份失败 → 抛出 → 迁移不执行
    let migrated = false;
    await assert.rejects(async () => {
      await backupBeforeNeteaseMigration(db, {
        databasePath,
        preExistingDatabase: true,
      });
      migrated = true;
      migrateNeteaseAccounts(db);
    });

    assert.equal(migrated, false);
    assert.equal(neteaseTableExists(db), false);
    db.close();
  } finally {
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});
