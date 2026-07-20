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
  const message = {
    id: String(row.id),
    channelId: row.channel_id,
    sender: row.sender_display_name,
    text: row.message_text,
    createdAt: row.created_at,
  };
  if (row.attachment_storage_name) {
    const channelId = encodeURIComponent(row.channel_id);
    const storageName = encodeURIComponent(row.attachment_storage_name);
    message.attachment = {
      url: `/api/channels/${channelId}/messages/attachments/${storageName}`,
      name: row.attachment_original_name,
      mimeType: row.attachment_mime_type,
      size: row.attachment_size,
      kind: String(row.attachment_mime_type || "").startsWith("image/") ? "image" : "file",
    };
  }
  return message;
}

export function listRecentChannelMessages(db, { channelId, limit }) {
  const safeLimit = Math.min(
    MAX_CHAT_HISTORY_LIMIT,
    Math.max(1, Number.isInteger(limit) ? limit : DEFAULT_CHAT_HISTORY_LIMIT)
  );
  return db
    .prepare(`
      SELECT id, channel_id, sender_display_name, message_text,
             attachment_storage_name, attachment_original_name,
             attachment_mime_type, attachment_size, created_at
      FROM (
        SELECT id, channel_id, sender_display_name, message_text,
               attachment_storage_name, attachment_original_name,
               attachment_mime_type, attachment_size, created_at
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
    attachment = null,
    historyLimit = DEFAULT_CHAT_HISTORY_LIMIT,
    now = Date.now(),
    onAttachmentsPruned = null,
  }
) {
  const result = db.transaction(() => {
    const channel = db.prepare("SELECT id FROM channels WHERE id = ?").get(channelId);
    if (!channel) {
      const error = new Error("频道不存在");
      error.code = "CHAT_CHANNEL_NOT_FOUND";
      throw error;
    }
    const info = db.prepare(`
      INSERT INTO channel_messages (
        channel_id, sender_principal_key, sender_display_name, message_text,
        attachment_storage_name, attachment_original_name,
        attachment_mime_type, attachment_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      channelId,
      senderPrincipalKey,
      senderDisplayName,
      typeof text === "string" ? text : "",
      attachment?.storageName || null,
      attachment?.originalName || null,
      attachment?.mimeType || null,
      Number.isInteger(attachment?.size) ? attachment.size : null,
      now
    );

    const prunedAttachments = db.prepare(`
      SELECT attachment_storage_name AS storageName
      FROM channel_messages
      WHERE channel_id = ?
        AND attachment_storage_name IS NOT NULL
        AND id NOT IN (
          SELECT id FROM channel_messages
          WHERE channel_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).all(channelId, channelId, historyLimit);

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

    return {
      message: publicMessage(
      db.prepare(`
        SELECT id, channel_id, sender_display_name, message_text,
               attachment_storage_name, attachment_original_name,
               attachment_mime_type, attachment_size, created_at
        FROM channel_messages WHERE id = ?
      `).get(info.lastInsertRowid)
      ),
      prunedAttachments,
    };
  })();

  if (typeof onAttachmentsPruned === "function") {
    for (const item of result.prunedAttachments) onAttachmentsPruned(item.storageName);
  }
  return result.message;
}

export function getChannelAttachment(db, { channelId, storageName }) {
  return db.prepare(`
    SELECT attachment_original_name AS originalName,
           attachment_mime_type AS mimeType,
           attachment_size AS size
    FROM channel_messages
    WHERE channel_id = ? AND attachment_storage_name = ?
  `).get(channelId, storageName) || null;
}

export function listChannelAttachmentStorageNames(db, channelId) {
  return db.prepare(`
    SELECT attachment_storage_name AS storageName
    FROM channel_messages
    WHERE channel_id = ? AND attachment_storage_name IS NOT NULL
  `).all(channelId).map((row) => row.storageName);
}
