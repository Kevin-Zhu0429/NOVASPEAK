import fs from "node:fs";
import path from "node:path";

export function userRoleSupportsOrdinaryUser(db) {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'users'
  `).get();
  return typeof row?.sql === "string" && /['"]user['"]/.test(row.sql);
}

export async function backupBeforeUserRoleMigration(db, {
  databasePath,
  preExistingDatabase,
} = {}) {
  if (!preExistingDatabase || userRoleSupportsOrdinaryUser(db)) {
    return { backedUp: false, backupPath: null };
  }
  const backupDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const backupPath = path.join(
    backupDirectory,
    `novaspeak-before-user-roles-${stamp}.db`
  );
  await db.backup(backupPath);
  return { backedUp: true, backupPath };
}

export function migrateUserRoles(db) {
  if (!userRoleSupportsOrdinaryUser(db)) {
    const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE users_role_v2 (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            username_key TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('admin', 'member', 'user')),
            created_at INTEGER NOT NULL,
            display_name TEXT,
            position TEXT NOT NULL DEFAULT 'member',
            avatar_path TEXT
          );

          INSERT INTO users_role_v2 (
            id, username, username_key, password_hash, role, created_at,
            display_name, position, avatar_path
          )
          SELECT
            id, username, username_key, password_hash, role, created_at,
            display_name, position, avatar_path
          FROM users;

          DROP TABLE users;
          ALTER TABLE users_role_v2 RENAME TO users;
        `);
      })();
    } finally {
      if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
    }
    const violations = db.pragma("foreign_key_check");
    if (violations.length > 0) {
      throw new Error("User role migration failed foreign key validation");
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS role_change_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id TEXT NOT NULL,
      actor_display_name TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_display_name TEXT NOT NULL,
      previous_role TEXT NOT NULL,
      next_role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS role_change_audit_target_index
      ON role_change_audit(target_user_id, created_at DESC);
  `);
}
