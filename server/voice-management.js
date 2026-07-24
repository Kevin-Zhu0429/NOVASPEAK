import { randomUUID } from "node:crypto";
import { TrackSource } from "livekit-server-sdk";
import {
  canMoveRole,
  canRemoveRole,
} from "./authorization.js";

// 只识别自建 LiveKit 未实现 moveParticipant 的 Twirp not implemented 错误；
// 401/403、participant not found、超时、密钥错误等其他错误一律不触发 fallback。
export function isMoveNotImplementedError(error) {
  if (!error) return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (message.includes("not implemented")) return true;
  const code = typeof error.code === "string" ? error.code.toLowerCase() : error.code;
  return code === "unimplemented" || error.status === 501;
}

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
  function participantRole(participant) {
    try {
      const metadata = JSON.parse(participant?.metadata || "{}");
      return ["admin", "member", "user", "guest"].includes(metadata.role)
        ? metadata.role
        : null;
    } catch {
      return null;
    }
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

  async function validateBase({
    actor,
    sourceChannelId,
    participantIdentity,
    allowAdminOnly = false,
    operation = "remove",
    requireParticipant = true,
  }) {
    if (!actor) return { status: 401, error: "请先登录" };
    if (allowAdminOnly && actor.role !== "admin") {
      return { status: 403, error: "只有管理员可以执行该操作" };
    }
    if (!allowAdminOnly && !["admin", "member", "user"].includes(actor.role)) {
      return { status: 403, error: "访客不能管理语音成员" };
    }
    const source = getChannel(sourceChannelId);
    if (!source) return { status: sourceChannelId ? 404 : 400, error: sourceChannelId ? "源频道不存在" : "请选择有效的源频道" };
    const identity = cleanIdentity(participantIdentity);
    if (!identity) return { status: 400, error: "请选择有效的目标成员" };
    if (identity === actor.id) return { status: 400, error: "不能对自己执行该操作" };
    const participant = await findParticipant(source.id, identity);
    if (!participant && requireParticipant) return { status: 404, error: "目标成员不在当前频道" };
    if (participant && !allowAdminOnly) {
      const targetRole = participantRole(participant);
      if (!targetRole) {
        return { status: 403, error: "无法确认目标成员权限" };
      }
      const allowed =
        operation === "move"
          ? canMoveRole(actor.role, targetRole)
          : canRemoveRole(actor.role, targetRole);
      if (!allowed) {
        return {
          status: 403,
          error: operation === "move"
            ? "你没有权限移动该成员"
            : "你没有权限将该成员移出频道",
        };
      }
    }
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
    // 只在“未静音 → 静音”真实成功后播报；alreadyMuted/idempotent 与 unmute 都不播报。
    // 范围：目标所在频道（mute 要求目标在源频道内）+ 目标本人 + 操作者
    presenceService?.broadcastAnnouncement?.(
      { eventType: "server_muted", actor: { displayName: displayName(base.participant) }, channelId: base.source.id, channelName: base.source.name },
      { type: "channels", channelIds: [base.source.id], includeParticipants: [base.identity, base.actor.id] },
    );
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
    const base = await validateBase({
      ...input,
      allowAdminOnly: false,
      operation: "move",
    });
    if (base.error) return base;
    const target = getChannel(input.targetChannelId);
    if (!target) return { status: input.targetChannelId ? 404 : 400, error: input.targetChannelId ? "目标频道不存在" : "请选择有效的目标频道" };
    if (target.id === base.source.id) return { status: 400, error: "目标频道不能与当前频道相同" };
    const state = serverMuteRecords.get(base.identity);
    // 在 LiveKit move 之前开启移动抑制窗口：客户端收到 RoomEvent.Moved 后的
    // set-location 回传可能先于服务端后续步骤到达，开窗必须抢在它前面
    presenceService?.beginParticipantMove?.(base.identity, target.id, target.name);
    let movedViaFallback = false;
    try {
      await roomService.moveParticipant(base.source.id, base.identity, target.id);
      if (state?.serverMuted) {
        state.currentRoomName = target.id;
        const movedParticipant = await waitForParticipant(target.id, base.identity);
        if (movedParticipant) await applyServerMutedState(target.id, base.identity, movedParticipant, state);
      }
    } catch (moveError) {
      if (!isMoveNotImplementedError(moveError)) {
        // move 失败：清理窗口，恢复正常进出播报，也不发 channel_moved
        presenceService?.cancelParticipantMove?.(base.identity);
        throw moveError;
      }
      // 自建 LiveKit 不支持服务端 moveParticipant：降级为通过现有 Presence WebSocket
      // 通知目标用户浏览器自行切换频道；只发给目标用户本人的连接
      const delivered = presenceService?.sendVoiceControlToParticipant?.(base.identity, base.source.id, {
        type: "voice_control",
        action: "force_move_channel",
        requestId: randomId(),
        targetChannelId: target.id,
        targetChannelName: target.name,
        sourceChannelId: base.source.id,
        reason: "admin_move",
      }) === true;
      if (!delivered) {
        // 目标用户没有在线 Presence 连接：明确失败，不假装成功
        presenceService?.cancelParticipantMove?.(base.identity);
        return { status: 409, error: "目标成员当前没有在线连接，无法移动频道" };
      }
      // 目标用户重连目标频道时由 /api/token 的 getTokenServerMute 重新施加静音
      if (state?.serverMuted) state.currentRoomName = target.id;
      movedViaFallback = true;
    }
    presenceService?.setConnectionLocation?.(base.identity, base.source.id, { state: "in_channel", channelId: target.id, channelName: target.name });
    presenceService?.sendCommandToChannelConnection?.(base.identity, target.id, { type: "presence:command", command: "moved-to-channel", requestId: randomId(), sourceChannelId: base.source.id, targetChannelId: target.id, targetChannelName: target.name });
    // 范围：源频道 + 目标频道 + 被移动者本人 + 操作者；payload 仍只带目标频道名供文案使用
    presenceService?.broadcastAnnouncement?.(
      { eventType: "channel_moved", actor: { displayName: displayName(base.participant) }, channelId: target.id, channelName: target.name },
      { type: "channels", channelIds: [base.source.id, target.id], includeParticipants: [base.identity, base.actor.id] },
    );
    return { success: true, participantName: displayName(base.participant), targetChannelName: target.name, serverMuted: Boolean(state?.serverMuted), movedViaFallback };
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
