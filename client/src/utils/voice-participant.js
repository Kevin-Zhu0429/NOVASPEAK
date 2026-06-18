import { Track } from "livekit-client";
import { getPositionText } from "./user-display";

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
  const user = { displayName, role, isGuest: role === "guest" || metadata.isGuest === true, positions, positionNames };
  return { ...user, positionText: getPositionText(user, role ? "队员" : "身份未知") };
}

export function participantView(participant, isLocal = false) {
  const microphone = participant?.getTrackPublication?.(Track.Source.Microphone);
  return {
    id: participant?.identity || (isLocal ? "local" : "unknown"),
    participant,
    isLocal,
    ...parseParticipantMetadata(participant),
    isSpeaking: Boolean(participant?.isSpeaking),
    audioLevel: Number(participant?.audioLevel) || 0,
    connectionQuality: participant?.connectionQuality,
    microphoneEnabled: Boolean(microphone) && !microphone.isMuted,
  };
}
