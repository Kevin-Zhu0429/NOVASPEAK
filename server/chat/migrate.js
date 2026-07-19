import fs from "node:fs";
import path from "node:path";

function chatTableExists(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get()
  );
}
export async function backupBeforeChatMigration(
  db,
  { databasePath, preExistingDatabase, now = new Date() }
) {
  if (!preExistingDatabase) return { backedUp: false, reason: "new-database" };
  if (chatTableExists(db)) return { backedUp: false, reason: "already-migrated" };

  const backupsDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const backupPath = path.join(
    backupsDirectory,
    `novaspeak-before-chat-history-${stamp}.db`
  );
  await db.backup(backupPath);
  return { backedUp: true, backupPath };
}

export function migrateChatMessages(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      sender_principal_key TEXT NOT NULL,
      sender_display_name TEXT NOT NULL,
      message_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,

      FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS channel_messages_channel_id_index
      ON channel_messages(channel_id, id DESC);
  `);
}
