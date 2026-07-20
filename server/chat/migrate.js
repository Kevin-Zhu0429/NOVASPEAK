import fs from "node:fs";
import path from "node:path";

function chatTableExists(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_messages'").get()
  );
}

const ATTACHMENT_COLUMNS = [
  "attachment_storage_name",
  "attachment_original_name",
  "attachment_mime_type",
  "attachment_size",
];

function chatAttachmentColumnsExist(db) {
  if (!chatTableExists(db)) return false;
  const columns = new Set(db.prepare("PRAGMA table_info(channel_messages)").all().map((column) => column.name));
  return ATTACHMENT_COLUMNS.every((column) => columns.has(column));
}
export async function backupBeforeChatMigration(
  db,
  { databasePath, preExistingDatabase, now = new Date() }
) {
  if (!preExistingDatabase) return { backedUp: false, reason: "new-database" };
  const tableExists = chatTableExists(db);
  if (tableExists && chatAttachmentColumnsExist(db)) {
    return { backedUp: false, reason: "already-migrated" };
  }

  const backupsDirectory = path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupsDirectory, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const backupPath = path.join(
    backupsDirectory,
    `novaspeak-before-chat-${tableExists ? "attachments" : "history"}-${stamp}.db`
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
      attachment_storage_name TEXT,
      attachment_original_name TEXT,
      attachment_mime_type TEXT,
      attachment_size INTEGER,
      created_at INTEGER NOT NULL,

      FOREIGN KEY (channel_id)
        REFERENCES channels(id)
        ON DELETE CASCADE
    );

  `);

  const columns = new Set(db.prepare("PRAGMA table_info(channel_messages)").all().map((column) => column.name));
  for (const column of ATTACHMENT_COLUMNS) {
    if (columns.has(column)) continue;
    const type = column === "attachment_size" ? "INTEGER" : "TEXT";
    db.exec(`ALTER TABLE channel_messages ADD COLUMN ${column} ${type}`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS channel_messages_channel_id_index
      ON channel_messages(channel_id, id DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS channel_messages_attachment_name_unique
      ON channel_messages(attachment_storage_name)
      WHERE attachment_storage_name IS NOT NULL;
  `);
}
