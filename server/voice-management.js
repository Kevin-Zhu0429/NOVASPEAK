import { randomUUID } from "node:crypto";
import { TrackSource } from "livekit-server-sdk";

export function createVoiceManagementService({ roomService, channelLookup, presenceService = null, randomId = randomUUID, retryDelayMs = 40 } = {}) {
  const serverMuteRecords = new Map();

  function cleanIdentity(value) { return typeof value === "string" ? value.trim() : ""; }
  function getChannel(id) { return typeof id === "string" && id.trim() ? channelLookup(id.trim()) : null; }
  async function participants(room) { return await roomService.listParticipants(room); }
  async function findParticipant(room, identity) {
    const list = await participants(room);
    return list.find((participant) => participant.identity === identity) || null;
  }
  function displayName(participant) {
    if (participant?.name) return participant.name;
    try {
      const metadata = JSON.parse(participant?.metadata || "{}");
      if (typeof metadata.displayName === "string" && metadata.displayName.trim()) return metadata.displayName.trim();
    } catch { /* ignore invalid metadata */ }
    return participant?.identity || "目标成员";
  }
  function microphoneTrack(participant) {
    return (participant?.tracks || []).find((track) => track.source === TrackSource.MICROPHONE || track.source === "MICROPHONE" || track.source === 2) || null;
  }
  function metadataWithServerMuted(participant, serverMuted) {
    let metadata = {};
    try { metadata = JSON.parse(participant?.metadata || "{}"); } catch { metadata = {}; }
    metadata.serverMuted = serverMuted;
    return JSON.stringify(metadata);
  }

  function permissionWithoutMicrophone(participantOrPermission) {
    const current = participantOrPermission?.permission || participantOrPermission || {};
    const sources = Array.isArray(current.canPublishSources) ? current.canPublishSources : [];
    const nextSources = sources.length ? sources.filter((source) => source !== TrackSource.MICROPHONE && source !== "MICROPHONE" && source !== 2) : [];
    return { ...current, canPublish: nextSources.length ? current.canPublish !== false : false, canSubscribe: current.canSubscribe !== false, canPublishData: current.canPublishData !== false, canPublishSources: nextSources };
  }

  function isMicrophoneRestricted(permission = {}) {
    if (permission.canPublish === false) return true;
    return Array.isArray(permission.canPublishSources) && permission.canPublishSources.length > 0 && !permission.canPublishSources.some((source) => source === TrackSource.MICROPHONE || source === "MICROPHONE" || source === 2);
  }

  async function validateBase({ actor, sourceChannelId, participantIdentity, allowAdminOnly = false, requireParticipant = true }) {
    if (!actor) return { status: 401, error: "请先登录" };
    if (allowAdminOnly ? actor.role !== "admin" : !["admin", "member"].includes(actor.role)) return { status: 403, error: allowAdminOnly ? "只有管理员可以执行该操作" : "该功能仅限正式战队成员" };
    const source = getChannel(sourceChannelId);
    if (!source) return { status: sourceChannelId ? 404 : 400, error: sourceChannelId ? "源频道不存在" : "请选择有效的源频道" };
    const identity = cleanIdentity(participantIdentity);
    if (!identity) return { status: 400, error: "请选择有效的目标成员" };
    if (identity === actor.id) return { status: 400, error: "不能对自己执行该操作" };
    const participant = await findParticipant(source.id, identity);
    if (!participant && requireParticipant) return { status: 404, error: "目标成员不在当前频道" };
    return { actor, source, identity, participant };
  }

  async function applyServerMutedState(room, identity, participant, state) {
    const target = participant || await findParticipant(room, identity);
    if (!target) return null;
    const track = microphoneTrack(target);
    if (track?.sid) await roomService.mutePublishedTrack(room, identity, track.sid, true);
    const permission = permissionWithoutMicrophone(target);
    await roomService.updateParticipant(room, identity, { metadata: metadataWithServerMuted(target, true), permission, name: target.name || undefined });
    state.currentRoomName = room;
    state.microphoneTrackSid = track?.sid || state.microphoneTrackSid || null;
    return target;
  }

  async function waitForParticipant(room, identity, attempts = 5) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const participant = await findParticipant(room, identity);
      if (participant) return participant;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return null;
  }

  async function mute(input) {
    const base = await validateBase({ ...input, allowAdminOnly: true });
    if (base.error) return base;
    const existing = serverMuteRecords.get(base.identity);
    if (existing?.serverMuted) {
      await applyServerMutedState(base.source.id, base.identity, base.participant, existing);
      return { success: true, ok: true, idempotent: true, alreadyMuted: true, serverMuted: true, participantName: displayName(base.participant) };
    }
    const originalPermission = base.participant.permission ? JSON.parse(JSON.stringify(base.participant.permission)) : {};
    const originalMetadata = base.participant.metadata || "";
    const state = { participantIdentity: base.identity, serverMuted: true, originalPermission, originalMetadata, currentRoomName: base.source.id, microphoneTrackSid: null };
    await applyServerMutedState(base.source.id, base.identity, base.participant, state);
    serverMuteRecords.set(base.identity, state);
    presenceService?.sendCommandToChannelConnection?.(base.identity, base.source.id, { type: "presence:command", command: "server-muted", requestId: randomId(), sourceChannelId: base.source.id });
    // 只在“未静音 → 静音”真实成功后播报；alreadyMuted/idempotent 与 unmute 都不播报
    presenceService?.broadcastAnnouncement?.({ eventType: "server_muted", actor: { displayName: displayName(base.participant) }, channelId: base.source.id, channelName: base.source.name });
    return { success: true, ok: true, serverMuted: true, participantName: displayName(base.participant) };
  }

  async function unmute(input) {
    const base = await validateBase({ ...input, allowAdminOnly: true, requireParticipant: false });
    if (base.error) return base;
    const state = serverMuteRecords.get(base.identity);
    if (!state?.serverMuted) return { success: true, ok: true, idempotent: true, serverMuted: false, participantName: displayName(base.participant) };
    const roomName = base.participant ? base.source.id : state.currentRoomName;
    const participant = base.participant || await findParticipant(roomName, base.identity);
    if (!participant) return { status: 404, error: "目标成员不在当前频道" };
    await roomService.updateParticipant(roomName, base.identity, { metadata: metadataWithServerMuted(participant, false), permission: state.originalPermission || {}, name: participant.name || undefined });
    serverMuteRecords.delete(base.identity);
    presenceService?.sendCommandToChannelConnection?.(base.identity, roomName, { type: "presence:command", command: "server-unmuted", requestId: randomId(), sourceChannelId: roomName });
    return { success: true, ok: true, serverMuted: false, participantName: displayName(participant) };
  }

  async function remove(input) {
    const base = await validateBase({ ...input, allowAdminOnly: false });
    if (base.error) return base;
    await roomService.removeParticipant(base.source.id, base.identity);
    presenceService?.sendCommandToChannelConnection?.(base.identity, base.source.id, { type: "presence:command", command: "removed-from-channel", requestId: randomId(), sourceChannelId: base.source.id });
    serverMuteRecords.delete(base.identity);
    presenceService?.setConnectionLocation?.(base.identity, base.source.id, { state: "lobby", channelId: null, channelName: "大厅" });
    return { success: true, participantName: displayName(base.participant) };
  }

  async function move(input) {
    const base = await validateBase({ ...input, allowAdminOnly: false });
    if (base.error) return base;
    const target = getChannel(input.targetChannelId);
    if (!target) return { status: input.targetChannelId ? 404 : 400, error: input.targetChannelId ? "目标频道不存在" : "请选择有效的目标频道" };
    if (target.id === base.source.id) return { status: 400, error: "目标频道不能与当前频道相同" };
    const state = serverMuteRecords.get(base.identity);
    await roomService.moveParticipant(base.source.id, base.identity, target.id);
    if (state?.serverMuted) {
      state.currentRoomName = target.id;
      const movedParticipant = await waitForParticipant(target.id, base.identity);
      if (movedParticipant) await applyServerMutedState(target.id, base.identity, movedParticipant, state);
    }
    // 先登记移动目标，让随后到达目标频道的 Presence 位置变化不再播进入/离开
    presenceService?.noteParticipantMoved?.(base.identity, target.id);
    presenceService?.setConnectionLocation?.(base.identity, base.source.id, { state: "in_channel", channelId: target.id, channelName: target.name });
    presenceService?.sendCommandToChannelConnection?.(base.identity, target.id, { type: "presence:command", command: "moved-to-channel", requestId: randomId(), sourceChannelId: base.source.id, targetChannelId: target.id, targetChannelName: target.name });
    presenceService?.broadcastAnnouncement?.({ eventType: "channel_moved", actor: { displayName: displayName(base.participant) }, channelId: target.id, channelName: target.name });
    return { success: true, participantName: displayName(base.participant), targetChannelName: target.name, serverMuted: Boolean(state?.serverMuted) };
  }

  function getServerMuteState(identity) { return serverMuteRecords.get(cleanIdentity(identity)) || null; }
  function isServerMuted(roomOrIdentity, maybeIdentity) { return Boolean(serverMuteRecords.get(cleanIdentity(maybeIdentity || roomOrIdentity))?.serverMuted); }
  function clearRoomParticipant(room, identity) { serverMuteRecords.delete(cleanIdentity(identity)); }
  function getTokenServerMute(identity, room) {
    const state = getServerMuteState(identity);
    if (state?.serverMuted) state.currentRoomName = room;
    return state?.serverMuted ? { serverMuted: true, permission: permissionWithoutMicrophone(state.originalPermission || {}) } : { serverMuted: false, permission: null };
  }

  return { mute, unmute, remove, move, isServerMuted, getServerMuteState, getTokenServerMute, clearRoomParticipant, _serverMutes: serverMuteRecords, _serverMuteRecords: serverMuteRecords, _isMicrophoneRestricted: isMicrophoneRestricted };
}
