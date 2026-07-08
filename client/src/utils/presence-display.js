import { getPositionText } from "./user-display.js";

const STATE_ORDER = { in_channel: 1, multi_channel: 1, reconnecting: 2, lobby: 3 };

export function parsePresenceMessage(raw) {
  try {
    const message = JSON.parse(raw);
    if (message?.type !== "presence:snapshot" || !Array.isArray(message.members)) return null;
    return message.members.filter((member) =>
      typeof member?.presenceId === "string" &&
      typeof member?.nickname === "string" &&
      ["lobby", "in_channel", "reconnecting", "multi_channel"].includes(member.state)
    );
  } catch {
    return null;
  }
}

export function sortPresenceMembers(members) {
  return members.map((member, index) => ({ member, index })).sort((left, right) =>
    Number(Boolean(right.member.isCurrentUser)) - Number(Boolean(left.member.isCurrentUser)) ||
    (STATE_ORDER[left.member.state] ?? 9) - (STATE_ORDER[right.member.state] ?? 9) ||
    left.member.nickname.localeCompare(right.member.nickname, "zh-CN") ||
    left.index - right.index
  ).map(({ member }) => member);
}

export function getPresenceLocationText(member) {
  if (member.state === "reconnecting") return `正在重连${member.channelName ? ` · ${member.channelName}` : ""}`;
  if (member.state === "multi_channel") return "多个频道";
  return member.channelName || (member.state === "lobby" ? "大厅" : "语音频道");
}

export function getPresencePositionText(member) {
  return getPositionText(member);
}

export function getPresenceDeviceText(member) {
  return member.deviceCount > 1 ? `${member.deviceCount} 个设备在线` : "";
}

export function buildPresenceWebSocketUrl(apiBase = "", location = window.location, { freshLogin = false } = {}) {
  const base = apiBase ? new URL(apiBase, location.href) : new URL(location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws/presence";
  // fresh=1 声明“本标签页首次上线”，让真实新登录穿透服务端启动静默窗口播欢迎
  base.search = freshLogin ? "?fresh=1" : "";
  base.hash = "";
  return base.toString();
}

// 本标签页是否已经有过 Presence 连接（sessionStorage 按标签页隔离，刷新保留）。
// 用于区分“真实新登录”（fresh）与“重连 / 刷新”（resume）：
// resume 不声明 fresh，服务端启动静默窗口照常吸收重连风暴。
export const PRESENCE_CONNECTED_MARKER_KEY = "novaPresenceConnected:v1";

function defaultSessionStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

// storage 不可用或异常时保守地不声明 fresh：宁可少播一次欢迎，
// 也不能让重启后的自动重连被误当成新登录造成欢迎风暴
export function shouldClaimFreshPresenceLogin(storage = defaultSessionStorage()) {
  try {
    if (!storage || typeof storage.getItem !== "function") return false;
    return storage.getItem(PRESENCE_CONNECTED_MARKER_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markPresenceConnected(storage = defaultSessionStorage()) {
  try {
    storage?.setItem?.(PRESENCE_CONNECTED_MARKER_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function clearPresenceConnectedMarker(storage = defaultSessionStorage()) {
  try {
    storage?.removeItem?.(PRESENCE_CONNECTED_MARKER_KEY);
    return true;
  } catch {
    return false;
  }
}
