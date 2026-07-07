import { Track } from "livekit-client";
import { getPositionText } from "./user-display.js";

export function parseParticipantMetadata(participant) {
  let metadata = {};
  if (participant?.metadata) {
    try {
      const parsed = JSON.parse(participant.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
  }
  const role = ["admin", "member", "guest"].includes(metadata.role) ? metadata.role : undefined;
  const positions = Array.isArray(metadata.positions) ? metadata.positions.filter((item) => typeof item === "string") : [];
  const positionNames = Array.isArray(metadata.positionNames) ? metadata.positionNames.filter((item) => typeof item === "string") : [];
  const displayName = typeof metadata.displayName === "string" && metadata.displayName.trim()
    ? metadata.displayName.trim()
    : participant?.name || participant?.identity || "未知用户";
  const user = { displayName, role, isGuest: role === "guest" || metadata.isGuest === true, positions, positionNames, serverMuted: metadata.serverMuted === true };
  return { ...user, positionText: getPositionText(user, role ? "队员" : "身份未知") };
}

export function isParticipantServerMuted(participant) {
  return parseParticipantMetadata(participant).serverMuted === true;
}

export function participantView(participant, isLocal = false) {
  const microphone = participant?.getTrackPublication?.(Track.Source.Microphone);
  const metadata = parseParticipantMetadata(participant);
  return {
    id: participant?.identity || (isLocal ? "local" : "unknown"),
    participant,
    isLocal,
    ...metadata,
    isSpeaking: Boolean(participant?.isSpeaking),
    audioLevel: Number(participant?.audioLevel) || 0,
    connectionQuality: participant?.connectionQuality,
    microphoneEnabled: Boolean(microphone) && !microphone.isMuted,
    serverMuted: isParticipantServerMuted(participant),
  };
}

export function getLocalServerMuteTransition(previousValue, currentValue, initialized) {
  const current = currentValue === true;
  if (!initialized) return { current, message: "" };
  if (previousValue === true && current === false) return { current, message: "服务器静音已解除，请自行开启麦克风" };
  if (previousValue === false && current === true) return { current, message: "你已被服务器静音" };
  return { current, message: "" };
}

export const MICROPHONE_RESTORE_FAILED_MESSAGE = "服务器静音已解除，但麦克风恢复失败，请手动开启。";
export const MICROPHONE_RESTORED_MESSAGE = "服务器静音已解除，麦克风已自动恢复";
export const MICROPHONE_RESTORING_MESSAGE = "服务器静音已解除，正在自动恢复麦克风";

// 解除服务器静音后的麦克风恢复计划（只针对本地用户自己，纯前端状态）：
// 进入禁音时记录当时麦克风是否开启，解除时只恢复“禁音前开启”的麦克风，
// 不强制开启用户主动关闭的麦克风。Deafen 不参与判断（恢复动作由调用方另行守护）。
export function getServerMuteMicrophonePlan({
  isLocal = false,
  previousServerMuted = false,
  currentServerMuted = false,
  microphoneEnabled = false,
  rememberedMicEnabled = null,
} = {}) {
  if (isLocal !== true) return { rememberedMicEnabled: null, shouldRestoreMicrophone: false };
  const previous = previousServerMuted === true;
  const current = currentServerMuted === true;
  if (!previous && current) {
    return { rememberedMicEnabled: microphoneEnabled === true, shouldRestoreMicrophone: false };
  }
  if (previous && !current) {
    return { rememberedMicEnabled: null, shouldRestoreMicrophone: rememberedMicEnabled === true };
  }
  return { rememberedMicEnabled: current ? rememberedMicEnabled === true : null, shouldRestoreMicrophone: false };
}
