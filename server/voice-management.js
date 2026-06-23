import { randomUUID } from "node:crypto";
import { TrackSource } from "livekit-server-sdk";

export function createVoiceManagementService({ roomService, channelLookup, presenceService = null, randomId = randomUUID } = {}) {
  const serverMutes = new Map();

  function muteKey(room, identity) { return `${room}\u0000${identity}`; }
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

  function permissionWithoutMicrophone(participant) {
    const current = participant?.permission || {};
    const sources = Array.isArray(current.canPublishSources) ? current.canPublishSources : [];
    const nextSources = sources.length ? sources.filter((source) => source !== TrackSource.MICROPHONE && source !== "MICROPHONE" && source !== 2) : [];
    return { ...current, canPublish: nextSources.length ? current.canPublish !== false : false, canSubscribe: current.canSubscribe !== false, canPublishData: current.canPublishData !== false, canPublishSources: nextSources };
  }

  async function validateBase({ actor, sourceChannelId, participantIdentity, allowAdminOnly = false }) {
    if (!actor) return { status: 401, error: "请先登录" };
    if (allowAdminOnly ? actor.role !== "admin" : !["admin", "member"].includes(actor.role)) return { status: 403, error: allowAdminOnly ? "只有管理员可以执行该操作" : "该功能仅限正式战队成员" };
    const source = getChannel(sourceChannelId);
    if (!source) return { status: sourceChannelId ? 404 : 400, error: sourceChannelId ? "源频道不存在" : "请选择有效的源频道" };
    const identity = cleanIdentity(participantIdentity);
    if (!identity) return { status: 400, error: "请选择有效的目标成员" };
    if (identity === actor.id) return { status: 400, error: "不能对自己执行该操作" };
    const participant = await findParticipant(source.id, identity);
    if (!participant) return { status: 404, error: "目标成员不在当前频道" };
    return { actor, source, identity, participant };
  }

  async function mute(input) {
    const base = await validateBase({ ...input, allowAdminOnly: true });
    if (base.error) return base;
    const key = muteKey(base.source.id, base.identity);
    const existing = serverMutes.get(key);
    if (existing?.serverMuted) return { success: true, idempotent: true, serverMuted: true, participantName: displayName(base.participant) };
    const originalPermission = base.participant.permission ? JSON.parse(JSON.stringify(base.participant.permission)) : {};
    const originalMetadata = base.participant.metadata || "";
    const track = microphoneTrack(base.participant);
    if (track?.sid) await roomService.mutePublishedTrack(base.source.id, base.identity, track.sid, true);
    await roomService.updateParticipant(base.source.id, base.identity, { metadata: metadataWithServerMuted(base.participant, true), permission: permissionWithoutMicrophone(base.participant), name: base.participant.name || undefined });
    serverMutes.set(key, { serverMuted: true, originalPermission, originalMetadata, trackSid: track?.sid || null });
    presenceService?.sendCommandToChannelConnection?.(base.identity, base.source.id, { type: "presence:command", command: "server-muted", requestId: randomId(), sourceChannelId: base.source.id });
    return { success: true, serverMuted: true, participantName: displayName(base.participant) };
  }

  async function unmute(input) {
    const base = await validateBase({ ...input, allowAdminOnly: true });
    if (base.error) return base;
    const key = muteKey(base.source.id, base.identity);
    const state = serverMutes.get(key);
    if (!state?.serverMuted) return { success: true, idempotent: true, serverMuted: false, participantName: displayName(base.participant) };
    await roomService.updateParticipant(base.source.id, base.identity, { metadata: metadataWithServerMuted(base.participant, false), permission: state.originalPermission || {}, name: base.participant.name || undefined });
    serverMutes.delete(key);
    presenceService?.sendCommandToChannelConnection?.(base.identity, base.source.id, { type: "presence:command", command: "server-unmuted", requestId: randomId(), sourceChannelId: base.source.id });
    return { success: true, serverMuted: false, participantName: displayName(base.participant) };
  }

  async function remove(input) {
    const base = await validateBase({ ...input, allowAdminOnly: false });
    if (base.error) return base;
    await roomService.removeParticipant(base.source.id, base.identity);
    presenceService?.sendCommandToChannelConnection?.(base.identity, base.source.id, { type: "presence:command", command: "removed-from-channel", requestId: randomId(), sourceChannelId: base.source.id });
    serverMutes.delete(muteKey(base.source.id, base.identity));
    presenceService?.setConnectionLocation?.(base.identity, base.source.id, { state: "lobby", channelId: null, channelName: "大厅" });
    return { success: true, participantName: displayName(base.participant) };
  }

  async function move(input) {
    const base = await validateBase({ ...input, allowAdminOnly: false });
    if (base.error) return base;
    const target = getChannel(input.targetChannelId);
    if (!target) return { status: input.targetChannelId ? 404 : 400, error: input.targetChannelId ? "目标频道不存在" : "请选择有效的目标频道" };
    if (target.id === base.source.id) return { status: 400, error: "目标频道不能与当前频道相同" };
    await roomService.moveParticipant(base.source.id, base.identity, target.id);
    serverMutes.delete(muteKey(base.source.id, base.identity));
    presenceService?.setConnectionLocation?.(base.identity, base.source.id, { state: "in_channel", channelId: target.id, channelName: target.name });
    presenceService?.sendCommandToChannelConnection?.(base.identity, target.id, { type: "presence:command", command: "moved-to-channel", requestId: randomId(), sourceChannelId: base.source.id, targetChannelId: target.id, targetChannelName: target.name });
    return { success: true, participantName: displayName(base.participant), targetChannelName: target.name };
  }

  function isServerMuted(room, identity) { return Boolean(serverMutes.get(muteKey(room, identity))?.serverMuted); }
  function clearRoomParticipant(room, identity) { serverMutes.delete(muteKey(room, identity)); }

  return { mute, unmute, remove, move, isServerMuted, clearRoomParticipant, _serverMutes: serverMutes };
}
