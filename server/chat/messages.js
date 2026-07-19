export const DEFAULT_CHAT_HISTORY_LIMIT = 300;
export const MIN_CHAT_HISTORY_LIMIT = 100;
export const MAX_CHAT_HISTORY_LIMIT = 500;
export const MAX_CHAT_MESSAGE_LENGTH = 2000;

function parseConfiguredLimit(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_CHAT_HISTORY_LIMIT;
  }
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed)) return DEFAULT_CHAT_HISTORY_LIMIT;
  return Math.min(MAX_CHAT_HISTORY_LIMIT, Math.max(MIN_CHAT_HISTORY_LIMIT, parsed));
}
export function getChatHistoryLimit(env = process.env) {
  return parseConfiguredLimit(env.CHAT_HISTORY_LIMIT);
}

export function normalizeChatText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH) return null;
  return text;
}

function publicMessage(row) {
  return {
    id: String(row.id),
    channelId: row.channel_id,
    sender: row.sender_display_name,
    text: row.message_text,
    createdAt: row.created_at,
  };
}

export function listRecentChannelMessages(db, { channelId, limit }) {
  const safeLimit = Math.min(
    MAX_CHAT_HISTORY_LIMIT,
    Math.max(1, Number.isInteger(limit) ? limit : DEFAULT_CHAT_HISTORY_LIMIT)
  );
  return db
    .prepare(`
      SELECT id, channel_id, sender_display_name, message_text, created_at
      FROM (
        SELECT id, channel_id, sender_display_name, message_text, created_at
        FROM channel_messages
        WHERE channel_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `)
    .all(channelId, safeLimit)
    .map(publicMessage);
}

export function saveChannelMessage(
  db,
  {
    channelId,
    senderPrincipalKey,
    senderDisplayName,
    text,
    historyLimit = DEFAULT_CHAT_HISTORY_LIMIT,
    now = Date.now(),
  }
) {
  return db.transaction(() => {
    const channel = db.prepare("SELECT id FROM channels WHERE id = ?").get(channelId);
    if (!channel) {
      const error = new Error("频道不存在");
      error.code = "CHAT_CHANNEL_NOT_FOUND";
      throw error;
    }
    const info = db.prepare(`
      INSERT INTO channel_messages (
        channel_id, sender_principal_key, sender_display_name, message_text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(channelId, senderPrincipalKey, senderDisplayName, text, now);

    db.prepare(`
      DELETE FROM channel_messages
      WHERE channel_id = ?
        AND id NOT IN (
          SELECT id FROM channel_messages
          WHERE channel_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).run(channelId, channelId, historyLimit);

    return publicMessage(
      db.prepare(`
        SELECT id, channel_id, sender_display_name, message_text, created_at
        FROM channel_messages WHERE id = ?
      `).get(info.lastInsertRowid)
    );
  })();
}
