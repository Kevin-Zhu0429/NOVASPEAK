import { DisconnectReason } from "livekit-client";

export function getDisconnectOutcome(reason, { moved = false, roomMatches = true } = {}) {
  if (!roomMatches) return { action: "ignore" };
  if (moved) return { action: "ignore" };
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
    return { action: "lobby", message: "你已被移出语音频道", removed: true };
  }
  return { action: "lobby", message: reason === DisconnectReason.CLIENT_INITIATED ? "" : "连接已断开", removed: false };
}

export function resolveMovedChannel(roomName, channels = []) {
  if (typeof roomName !== "string" || !roomName) return null;
  return channels.find((item) => item?.id === roomName) || null;
}

// 解析 Presence WS 上的 voice_control / force_move_channel 控制消息（自建 LiveKit
// 不支持服务端 moveParticipant 时的应用层强制移动）。其他类型、其他 action、
// 缺少目标频道的消息一律返回 null，不误处理。
export function parseForceMoveChannelMessage(raw) {
  try {
    const message = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (message?.type !== "voice_control" || message.action !== "force_move_channel") return null;
    if (typeof message.targetChannelId !== "string" || !message.targetChannelId.trim()) return null;
    return {
      targetChannelId: message.targetChannelId.trim(),
      targetChannelName: typeof message.targetChannelName === "string" ? message.targetChannelName.trim() : "",
      sourceChannelId: typeof message.sourceChannelId === "string" ? message.sourceChannelId : "",
    };
  } catch {
    return null;
  }
}

// force_move_channel → 应用层切频道计划：频道 ID + 被移动者可见的提示文案。
// 频道名优先取本地频道列表（与 UI 一致），列表未同步时退回消息内名称。
export function getForceMovePlan(raw, channels = []) {
  const command = parseForceMoveChannelMessage(raw);
  if (!command) return null;
  const targetChannel = channels.find((item) => item?.id === command.targetChannelId) || null;
  const targetName = targetChannel?.name || command.targetChannelName || "目标频道";
  return { channelId: command.targetChannelId, notice: `你已被移动到“${targetName}”` };
}
