import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateChannels } from "./channels.js";
import { migrateAvatarColumn } from "./avatar.js";
import {
  backupBeforeNeteaseMigration,
  migrateNeteaseAccounts,
} from "./music/migrate.js";
import {
  backupBeforeMusicQueueMigration,
  backupBeforeMusicQueueOrderingMigration,
  migrateMusicQueue,
} from "./music/queue-migrate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDirectory = path.join(__dirname, "data");
const databasePath = process.env.NOVASPEAK_DB_PATH
  ? path.resolve(process.env.NOVASPEAK_DB_PATH)
  : path.join(dataDirectory, "novaspeak.db");

fs.mkdirSync(path.dirname(databasePath), {
  recursive: true,
});

fs.mkdirSync(dataDirectory, {
  recursive: true,
});

// 打开数据库会自动创建文件，因此必须在打开前判断
// “数据库在本次启动前是否已经存在且非空”，供首次网易云迁移备份使用
const preExistingDatabase =
  fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;

const db = new Database(databasePath);

// 开启外键约束
db.pragma("foreign_keys = ON");

// 提高小型服务的读写体验
db.pragma("journal_mode = WAL");

// 创建数据表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,

    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,

    password_hash TEXT NOT NULL,

    role TEXT NOT NULL DEFAULT 'member'
      CHECK (role IN ('member', 'admin')),

    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,

    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS sessions_user_id_index
    ON sessions(user_id);

  CREATE INDEX IF NOT EXISTS sessions_expires_at_index
    ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,

    owner_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,

    created_at INTEGER NOT NULL,

    FOREIGN KEY (owner_id)
      REFERENCES users(id)
      ON DELETE SET NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_positions (
    user_id INTEGER NOT NULL,
    position TEXT NOT NULL CHECK (
      position IN (
        'captain',
        'commander',
        'entry',
        'sniper',
        'support',
        'rifler',
        'freeman',
        'backup',
        'member'
      )
    ),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, position),

    FOREIGN KEY (user_id)
      REFERENCES users(id)
      ON DELETE CASCADE
  );
`);

// 兼容旧数据库：为 users 表增加 display_name 字段
const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all();

const hasDisplayName = userColumns.some(
  (column) => column.name === "display_name"
);

if (!hasDisplayName) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN display_name TEXT
  `);

  console.log("Database migration: added users.display_name");
}

// 兼容旧数据库：增加战队职位字段
const latestUserColumns = db
  .prepare("PRAGMA table_info(users)")
  .all();

const hasPosition = latestUserColumns.some(
  (column) => column.name === "position"
);

if (!hasPosition) {
  db.exec(`
    ALTER TABLE users
    ADD COLUMN position TEXT NOT NULL DEFAULT 'member'
  `);

  console.log(
    "Database migration: added users.position"
  );
}

// 系统管理员账号默认为队长职位
db.prepare(`
  UPDATE users
  SET position = 'captain'
  WHERE role = 'admin'
`).run();

// 旧用户没有显示名称时，暂时使用成员 ID
db.prepare(`
  UPDATE users
  SET display_name = username
  WHERE
    display_name IS NULL
    OR TRIM(display_name) = ''
`).run();


// 兼容旧数据库：增加头像相对路径字段，旧用户默认 NULL
migrateAvatarColumn(db);

migrateChannels(db);

// 网易云音乐机器人：账号绑定凭据表。
// 首次迁移前对既有数据库做在线备份；备份失败必须让启动失败，
// 绝不允许忽略错误继续执行 schema 迁移。
const neteaseBackup = await backupBeforeNeteaseMigration(db, {
  databasePath,
  preExistingDatabase,
});
if (neteaseBackup.backedUp) {
  console.log(
    `Database backup created before Netease migration: ${neteaseBackup.backupPath}`
  );
}
migrateNeteaseAccounts(db);

// 频道音乐队列表：首次迁移前同样先在线备份，失败则启动失败
const musicQueueBackup = await backupBeforeMusicQueueMigration(db, {
  databasePath,
  preExistingDatabase,
});
if (musicQueueBackup.backedUp) {
  console.log(
    `Database backup created before music queue migration: ${musicQueueBackup.backupPath}`
  );
}
const musicQueueOrderingBackup = await backupBeforeMusicQueueOrderingMigration(
  db,
  { databasePath, preExistingDatabase }
);
if (musicQueueOrderingBackup.backedUp) {
  console.log(
    `Database backup created before music queue ordering migration: ${musicQueueOrderingBackup.backupPath}`
  );
}
migrateMusicQueue(db);

console.log(`SQLite database ready: ${databasePath}`);

export default db;
