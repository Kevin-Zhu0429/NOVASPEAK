// netease_accounts 表迁移：保存每个 NOVASPEAK 身份（正式成员或 guest:* 访客）
// 绑定的网易云账号加密凭据。迁移可重复执行，不触碰现有表和数据。
//
// 说明：principal_key 直接使用服务端认证得到的用户 id（访客形如 guest:UUID），
// 访客不在 users 表中，因此这里刻意不建外键，靠服务层做身份隔离。
// 数据库中只允许出现 AES-256-GCM 密文，绝不落明文 Cookie。

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
