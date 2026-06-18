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

export function buildPresenceWebSocketUrl(apiBase = "", location = window.location) {
  const base = apiBase ? new URL(apiBase, location.href) : new URL(location.href);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/ws/presence";
  base.search = "";
  base.hash = "";
  return base.toString();
}
