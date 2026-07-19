import express from "express";
import {
  MAX_CHAT_MESSAGE_LENGTH,
  getChatHistoryLimit,
  listRecentChannelMessages,
  normalizeChatText,
  saveChannelMessage,
} from "./messages.js";

function principalKey(user) {
  return user?.isGuest ? user.id : `user:${user.id}`;
}

export function createChatRouter({
  db,
  requireAuthenticated,
  presenceService,
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

  return router;
}
