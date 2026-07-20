import express from "express";
import {
  getChannelAttachment,
  MAX_CHAT_MESSAGE_LENGTH,
  getChatHistoryLimit,
  listRecentChannelMessages,
  normalizeChatText,
  saveChannelMessage,
} from "./messages.js";
import {
  CHAT_ATTACHMENT_BODY_LIMIT,
  contentDispositionFileName,
} from "./attachments.js";

function principalKey(user) {
  return user?.isGuest ? user.id : `user:${user.id}`;
}

export function createChatRouter({
  db,
  requireAuthenticated,
  presenceService,
  attachmentStore,
  env = process.env,
}) {
  // 该 Router 挂在 /api/channels/:channelId/messages 下，必须继承父级参数。
  const router = express.Router({ mergeParams: true });
  const historyLimit = getChatHistoryLimit(env);

  router.use(requireAuthenticated);
  router.use((req, res, next) => {
    const channelId = req.params.channelId;
    if (typeof channelId !== "string" || !channelId || channelId.length > 128) {
      return res.status(400).json({ error: "频道 ID 无效", code: "CHAT_INVALID_CHANNEL" });
    }
    if (!presenceService?.isUserInChannel?.(req.authUser.id, channelId)) {
      return res.status(403).json({ error: "请先进入该语音频道", code: "CHAT_NOT_IN_CHANNEL" });
    }
    next();
  });

  router.get("/", (req, res) => {
    try {
      return res.json({
        messages: listRecentChannelMessages(db, {
          channelId: req.params.channelId,
          limit: historyLimit,
        }),
        limit: historyLimit,
      });
    } catch (error) {
      console.error("Chat history query error:", error?.message || "unknown error");
      return res.status(500).json({ error: "加载聊天记录失败" });
    }
  });

  router.get("/attachments/:storageName", (req, res) => {
    if (!attachmentStore) return res.status(503).json({ error: "文件功能尚未配置" });
    const metadata = getChannelAttachment(db, {
      channelId: req.params.channelId,
      storageName: req.params.storageName,
    });
    const filePath = metadata ? attachmentStore.getFilePath(req.params.storageName) : null;
    if (!metadata || !filePath) return res.status(404).json({ error: "文件不存在" });

    const disposition = String(metadata.mimeType || "").startsWith("image/") ? "inline" : "attachment";
    res.setHeader("Content-Type", metadata.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(metadata.size));
    res.setHeader("Content-Disposition", `${disposition}; ${contentDispositionFileName(metadata.originalName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(filePath);
  });

  router.post("/", (req, res) => {
    const text = normalizeChatText(req.body?.text);
    if (!text) {
      return res.status(400).json({
        error: `消息不能为空且不能超过 ${MAX_CHAT_MESSAGE_LENGTH} 个字符`,
        code: "CHAT_INVALID_MESSAGE",
      });
    }
    try {
      const message = saveChannelMessage(db, {
        channelId: req.params.channelId,
        senderPrincipalKey: principalKey(req.authUser),
        senderDisplayName: req.authUser.displayName || req.authUser.nickname || "成员",
        text,
        historyLimit,
        onAttachmentsPruned: attachmentStore?.remove,
      });
      return res.status(201).json({ message });
    } catch (error) {
      if (error?.code === "CHAT_CHANNEL_NOT_FOUND") {
        return res.status(404).json({ error: "频道不存在", code: error.code });
      }
      console.error("Chat message save error:", error?.message || "unknown error");
      return res.status(500).json({ error: "保存聊天消息失败" });
    }
  });

  router.post(
    "/attachments",
    express.raw({ type: "application/octet-stream", limit: CHAT_ATTACHMENT_BODY_LIMIT }),
    (req, res) => {
      if (!attachmentStore) return res.status(503).json({ error: "文件功能尚未配置" });
      let stored = null;
      try {
        stored = attachmentStore.save({
          encodedName: req.get("X-Nova-File-Name"),
          data: req.body,
        });
        const message = saveChannelMessage(db, {
          channelId: req.params.channelId,
          senderPrincipalKey: principalKey(req.authUser),
          senderDisplayName: req.authUser.displayName || req.authUser.nickname || "成员",
          text: "",
          attachment: stored,
          historyLimit,
          onAttachmentsPruned: attachmentStore.remove,
        });
        return res.status(201).json({ message });
      } catch (error) {
        if (stored?.storageName) attachmentStore.remove(stored.storageName);
        if (error?.code === "CHAT_CHANNEL_NOT_FOUND") {
          return res.status(404).json({ error: "频道不存在", code: error.code });
        }
        if (typeof error?.code === "string" && error.code.startsWith("CHAT_ATTACHMENT_")) {
          const status = error.code === "CHAT_ATTACHMENT_TOO_LARGE" ? 413 : 400;
          return res.status(status).json({ error: error.message, code: error.code });
        }
        console.error("Chat attachment save error:", error?.code || "unknown error");
        return res.status(500).json({ error: "保存文件失败" });
      }
    }
  );

  router.use((error, req, res, next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        error: "单个文件不能超过 20MB",
        code: "CHAT_ATTACHMENT_TOO_LARGE",
      });
    }
    next(error);
  });

  return router;
}
