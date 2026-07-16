// netease_accounts 表迁移：保存每个 NOVASPEAK 身份（正式成员或 guest:* 访客）
// 绑定的网易云账号加密凭据。迁移可重复执行，不触碰现有表和数据。
//
// 说明：principal_key 直接使用服务端认证得到的用户 id（访客形如 guest:UUID），
// 访客不在 users 表中，因此这里刻意不建外键，靠服务层做身份隔离。
// 数据库中只允许出现 AES-256-GCM 密文，绝不落明文 Cookie。

import fs from "node:fs";
import path from "node:path";

export function neteaseTableExists(db) {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'netease_accounts'"
      )
      .get()
  );
}

/**
 * 首次执行网易云迁移前备份数据库。
 *
 * 只有同时满足以下条件才备份：
 * 1. 数据库文件在本次启动前已经存在且非空（preExistingDatabase 由调用方
 *    在打开数据库之前判断，因为打开动作本身会创建文件）；
 * 2. netease_accounts 表尚不存在（即本次启动将首次执行该迁移）。
 *
 * 使用 better-sqlite3 的在线 backup API（WAL 模式下安全），
 * 绝不用 fs.copyFileSync 复制单个 .db 文件。
 * 备份失败时抛出异常——调用方不得捕获后继续迁移，必须让启动明确失败。
 */
export async function backupBeforeNeteaseMigration(
  db,
  { databasePath, preExistingDatabase, now = new Date() }
) {
  if (!preExistingDatabase) {
    return { backedUp: false, reason: "new-database" };
  }
  if (neteaseTableExists(db)) {
    return { backedUp: false, reason: "already-migrated" };
  }

  const backupsDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });

  // 例：novaspeak-before-netease-20260715T123456.db
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "");
  const backupPath = path.join(
    backupsDirectory,
    `novaspeak-before-netease-${stamp}.db`
  );

  await db.backup(backupPath);

  return { backedUp: true, backupPath };
}

export function migrateNeteaseAccounts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS netease_accounts (
      principal_key TEXT PRIMARY KEY,

      encrypted_cookie TEXT NOT NULL,
      cookie_iv TEXT NOT NULL,
      cookie_auth_tag TEXT NOT NULL,

      netease_user_id TEXT,
      nickname TEXT,
      avatar_url TEXT,

      credential_expires_at TEXT,

      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS netease_accounts_expires_index
      ON netease_accounts(credential_expires_at);
  `);
}
