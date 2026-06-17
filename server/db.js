import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDirectory = path.join(__dirname, "data");
const databasePath = path.join(dataDirectory, "novaspeak.db");

fs.mkdirSync(dataDirectory, {
  recursive: true,
});

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

function normalizeKey(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
}

// 默认频道
const defaultChannels = [
  {
    id: "lobby",
    name: "大厅",
  },
  {
    id: "cs2",
    name: "CS2",
  },
  {
    id: "delta-force",
    name: "三角洲行动",
  },
  {
    id: "apex",
    name: "Apex",
  },
  {
    id: "private-room",
    name: "私人房间",
  },
];

const insertDefaultChannel = db.prepare(`
  INSERT OR IGNORE INTO channels (
    id,
    name,
    name_key,
    owner_id,
    is_default,
    created_at
  )
  VALUES (
    @id,
    @name,
    @nameKey,
    NULL,
    1,
    @createdAt
  )
`);

const seedDefaultChannels = db.transaction(() => {
  const createdAt = Date.now();

  for (const channel of defaultChannels) {
    insertDefaultChannel.run({
      id: channel.id,
      name: channel.name,
      nameKey: normalizeKey(channel.name),
      createdAt,
    });
  }
});

seedDefaultChannels();

console.log(`SQLite database ready: ${databasePath}`);

export default db;