export const CLIENT_CHAT_MESSAGE_LIMIT = 500;
export const CHAT_TIME_DIVIDER_GAP_MS = 5 * 60 * 1000;

export function normalizeChatMessage(raw, fallbackNow = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const attachment = normalizeChatAttachment(raw.attachment);
  if (!text && !attachment) return null;
  const createdAt = Number(raw.createdAt);
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : null,
    channelId: typeof raw.channelId === "string" ? raw.channelId : null,
    sender: typeof raw.sender === "string" && raw.sender.trim() ? raw.sender.trim() : "成员",
    text,
    attachment,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : fallbackNow,
  };
}
export function mergeChatMessages(...collections) {
  const byKey = new Map();
  for (const collection of collections) {
    for (const raw of Array.isArray(collection) ? collection : []) {
      const message = normalizeChatMessage(raw);
      if (!message) continue;
      const key = message.id || `${message.createdAt}:${message.sender}:${message.text}:${message.attachment?.url || ""}`;
      byKey.set(key, message);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .slice(-CLIENT_CHAT_MESSAGE_LIMIT);
}

export function shouldShowChatTimeDivider(previous, current) {
  if (!current) return false;
  if (!previous) return true;
  const previousDate = new Date(previous.createdAt);
  const currentDate = new Date(current.createdAt);
  return (
    previousDate.toDateString() !== currentDate.toDateString() ||
    current.createdAt - previous.createdAt >= CHAT_TIME_DIVIDER_GAP_MS
  );
}

export function formatChatTime(value, { divider = false } = {}) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  if (!divider) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今天 ${time}`;
  return `${date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} ${time}`;
}
import { normalizeChatAttachment } from "./chat-attachments.js";
