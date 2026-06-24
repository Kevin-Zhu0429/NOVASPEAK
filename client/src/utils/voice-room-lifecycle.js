import { ConnectionState } from "livekit-client";

export function isVoiceRoomAttemptCurrent({ disposed, roomRef, room, connectAttemptRef, attemptId }) {
  return !disposed && roomRef?.current === room && connectAttemptRef?.current === attemptId;
}

export function shouldIgnoreConnectErrorForAttempt({ disposed, roomRef, room, connectAttemptRef, attemptId }) {
  return !isVoiceRoomAttemptCurrent({ disposed, roomRef, room, connectAttemptRef, attemptId });
}

export function cleanupVoiceRoomAttempt({ room, roomRef, disconnectReasonRef, reason = "effect-cleanup" }) {
  if (disconnectReasonRef) disconnectReasonRef.current = reason;
  if (roomRef?.current === room) roomRef.current = null;
  if (room?.state !== ConnectionState.Disconnected) {
    room.disconnect();
    return true;
  }
  return false;
}
