import { Track } from "livekit-client";
import { getPositionText } from "./user-display.js";
import { getLocalAudioMemberKey } from "./local-audio-preferences.js";

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
  const publicMemberId = typeof metadata.publicMemberId === "string" ? metadata.publicMemberId : (typeof metadata.memberId === "string" ? metadata.memberId : (typeof metadata.userId === "string" ? metadata.userId : undefined));
  const user = { displayName, role, isGuest: role === "guest" || metadata.isGuest === true, positions, positionNames, serverMuted: metadata.serverMuted === true, publicMemberId };
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
    memberKey: getLocalAudioMemberKey({ ...metadata, id: participant?.identity, identity: participant?.identity }),
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
