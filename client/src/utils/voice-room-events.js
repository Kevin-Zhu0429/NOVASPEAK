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
