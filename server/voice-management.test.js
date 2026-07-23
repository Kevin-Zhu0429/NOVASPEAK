import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceManagementService, isMoveNotImplementedError } from "./voice-management.js";

const admin = { id: "admin-id", role: "admin", displayName: "Admin" };
const member = { id: "member-id", role: "member", displayName: "Member", positions: ["captain"] };
const guest = { id: "guest:g", role: "guest", displayName: "Guest", isGuest: true };
const target = {
  identity: "target-id",
  name: "目标成员",
  metadata: JSON.stringify({ displayName: "目标成员", role: "member" }),
  permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2, 3] },
  tracks: [{ sid: "mic-track", source: 2 }],
};

function makeService({ participants = [target], moveError = null, voiceControlDelivered = true } = {}) {
  const calls = [];
  const presence = {
    events: [],
    announcements: [],
    moves: [],
    voiceControls: [],
    setConnectionLocation(identity, source, next) { this.events.push(["set", identity, source, next]); return true; },
    sendCommandToChannelConnection(identity, channel, command) { this.events.push(["cmd", identity, channel, command.command]); return true; },
    sendVoiceControlToParticipant(identity, sourceChannelId, payload) { this.voiceControls.push([identity, sourceChannelId, payload]); return voiceControlDelivered; },
    beginParticipantMove(identity, targetChannelId, targetChannelName) { this.moves.push(["begin", identity, targetChannelId, targetChannelName]); return true; },
    cancelParticipantMove(identity) { this.moves.push(["cancel", identity]); return true; },
    broadcastAnnouncement(event, scope) { this.announcements.push({ ...event, scope }); return event; },
  };
  const service = createVoiceManagementService({
    roomService: {
      async listParticipants(room) { calls.push(["list", room]); return participants; },
      async mutePublishedTrack(room, identity, trackSid, muted) { calls.push(["muteTrack", room, identity, trackSid, muted]); },
      async updateParticipant(room, identity, options) { calls.push(["update", room, identity, options]); },
      async removeParticipant(room, identity) { calls.push(["remove", room, identity]); },
      async moveParticipant(room, identity, destination) {
        calls.push(["move", room, identity, destination]);
        if (moveError) throw moveError;
      },
    },
    channelLookup(id) { return { cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" } }[id] || null; },
    presenceService: presence,
    randomId: () => "request-id",
  });
  return { service, calls, presence };
}

function twirpNotImplementedError() {
  const error = new Error("twirp error unknown: not implemented");
  error.status = 500;
  return error;
}

test("voice management role permissions are based only on role", async () => {
  const { service } = makeService();
  assert.equal((await service.mute({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.unmute({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.remove({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.move({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" })).status, 403);
  assert.equal((await service.remove({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" })).success, true);
  assert.equal((await service.move({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" })).success, true);
});

test("ordinary user moves users and guests only; member can also move members", async () => {
  const ordinaryActor = { id: "ordinary-id", role: "user", displayName: "Ordinary" };
  const userTarget = {
    ...target,
    metadata: JSON.stringify({ displayName: "普通用户", role: "user" }),
  };
  const guestTarget = {
    ...target,
    metadata: JSON.stringify({ displayName: "访客", role: "guest" }),
  };
  assert.equal((await makeService({ participants: [userTarget] }).service.move({
    actor: ordinaryActor,
    sourceChannelId: "cs2",
    participantIdentity: "target-id",
    targetChannelId: "apex",
  })).success, true);
  assert.equal((await makeService({ participants: [guestTarget] }).service.move({
    actor: ordinaryActor,
    sourceChannelId: "cs2",
    participantIdentity: "target-id",
    targetChannelId: "apex",
  })).success, true);
  assert.equal((await makeService().service.move({
    actor: ordinaryActor,
    sourceChannelId: "cs2",
    participantIdentity: "target-id",
    targetChannelId: "apex",
  })).status, 403);
  assert.equal((await makeService().service.remove({
    actor: ordinaryActor,
    sourceChannelId: "cs2",
    participantIdentity: "target-id",
  })).status, 403);
});

test("voice management rejects missing auth, self operations and invalid parameters", async () => {
  const { service } = makeService({ participants: [] });
  assert.equal((await service.remove({ actor: null, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 401);
  assert.equal((await service.remove({ actor: admin, sourceChannelId: "missing", participantIdentity: "target-id" })).status, 404);
  assert.equal((await service.remove({ actor: admin, sourceChannelId: "cs2", participantIdentity: "admin-id" })).status, 400);
  assert.equal((await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "cs2" })).status, 404);
  const present = makeService();
  assert.equal((await present.service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "cs2" })).status, 400);
});

test("admin mute uses LiveKit track mute and participant permissions, then restores original permissions", async () => {
  const { service, calls } = makeService();
  const muted = await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(muted.serverMuted, true);
  assert.deepEqual(calls.find((call) => call[0] === "muteTrack"), ["muteTrack", "cs2", "target-id", "mic-track", true]);
  const update = calls.find((call) => call[0] === "update");
  assert.equal(update[3].permission.canPublishSources.includes(2), false);
  assert.equal((await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" })).idempotent, true);
  const unmuted = await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(unmuted.serverMuted, false);
  const lastUpdate = calls.filter((call) => call[0] === "update").at(-1);
  assert.deepEqual(lastUpdate[3].permission, target.permission);
  assert.equal((await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" })).idempotent, true);
});

test("remove and move call real LiveKit wrapper methods and update only source channel presence", async () => {
  const { service, calls, presence } = makeService();
  await service.remove({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.deepEqual(calls.find((call) => call[0] === "remove"), ["remove", "cs2", "target-id"]);
  assert.deepEqual(presence.events.find((event) => event[0] === "set").slice(0, 3), ["set", "target-id", "cs2"]);
  await service.move({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.deepEqual(calls.find((call) => call[0] === "move"), ["move", "cs2", "target-id", "apex"]);
});


test("muted member move migrates canonical record and reapplies metadata and permissions", async () => {
  const targetByRoom = {
    cs2: { ...target },
    apex: { ...target, metadata: JSON.stringify({ displayName: "目标成员", role: "member" }), permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2, 3] } },
  };
  const calls = [];
  const service = createVoiceManagementService({
    retryDelayMs: 1,
    roomService: {
      async listParticipants(room) { calls.push(["list", room]); return [targetByRoom[room]].filter(Boolean); },
      async mutePublishedTrack(room, identity, trackSid, muted) { calls.push(["muteTrack", room, identity, trackSid, muted]); },
      async updateParticipant(room, identity, options) { calls.push(["update", room, identity, options]); targetByRoom[room] = { ...targetByRoom[room], metadata: options.metadata, permission: options.permission }; },
      async removeParticipant() {},
      async moveParticipant(room, identity, destination) { calls.push(["move", room, identity, destination]); targetByRoom[destination] = { ...targetByRoom[room], metadata: "{}", permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2, 3] } }; delete targetByRoom[room]; },
    },
    channelLookup(id) { return { cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" } }[id] || null; },
  });
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  await service.move({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.equal(service.getServerMuteState("target-id").currentRoomName, "apex");
  assert.equal(JSON.parse(targetByRoom.apex.metadata).serverMuted, true);
  assert.equal(targetByRoom.apex.permission.canPublishSources.includes(2), false);
  const unmuted = await service.unmute({ actor: admin, sourceChannelId: "apex", participantIdentity: "target-id" });
  assert.equal(unmuted.serverMuted, false);
  assert.equal(JSON.parse(targetByRoom.apex.metadata).serverMuted, false);
  assert.deepEqual(targetByRoom.apex.permission, target.permission);
});

test("token server mute lookup updates room without muting other connection identities", async () => {
  const { service } = makeService({ participants: [{ ...target, identity: "user-id:voice:tab-a" }] });
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "user-id:voice:tab-a" });
  const muted = service.getTokenServerMute("user-id:voice:tab-a", "apex");
  const otherTab = service.getTokenServerMute("user-id:voice:tab-b", "apex");
  assert.equal(muted.serverMuted, true);
  assert.equal(service.getServerMuteState("user-id:voice:tab-a").currentRoomName, "apex");
  assert.equal(otherTab.serverMuted, false);
});

test("repeat mute repairs missing metadata and restored permissions", async () => {
  const mutable = { ...target };
  const { service } = makeService({ participants: [mutable] });
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  mutable.metadata = JSON.stringify({ displayName: "目标成员" });
  mutable.permission = { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2, 3] };
  const repaired = await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(repaired.alreadyMuted, true);
  assert.equal(repaired.serverMuted, true);
});

// ---------- 3B：移动 / 服务器静音的播报事件 ----------

test("move 在 LiveKit 移动前开启抑制窗口，成功后只产生一条 channel_moved", async () => {
  const { service, calls, presence } = makeService();
  await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.deepEqual(presence.moves, [["begin", "target-id", "apex", "Apex"]]);
  // beginParticipantMove 必须先于 roomService.moveParticipant 被调用
  assert.equal(calls.some((call) => call[0] === "move"), true);
  assert.equal(presence.announcements.length, 1);
  assert.equal(presence.announcements[0].eventType, "channel_moved");
  assert.equal(presence.announcements[0].channelName, "Apex");
  assert.equal(presence.announcements[0].channelId, "apex");
  assert.equal(presence.announcements[0].actor.displayName, "目标成员");
  assert.equal(presence.announcements.some((item) => ["channel_joined", "channel_left"].includes(item.eventType)), false);
  // 范围：源频道 + 目标频道 + 被移动者本人 + 操作者
  assert.deepEqual(presence.announcements[0].scope, { type: "channels", channelIds: ["cs2", "apex"], includeParticipants: ["target-id", "admin-id"] });
});

test("move 失败时清理移动窗口且不发送 channel_moved", async () => {
  const calls = [];
  const presence = {
    moves: [],
    announcements: [],
    beginParticipantMove(identity, targetChannelId, targetChannelName) { this.moves.push(["begin", identity, targetChannelId, targetChannelName]); return true; },
    cancelParticipantMove(identity) { this.moves.push(["cancel", identity]); return true; },
    broadcastAnnouncement(event) { this.announcements.push(event); return event; },
    setConnectionLocation() { return true; },
    sendCommandToChannelConnection() { return true; },
  };
  const service = createVoiceManagementService({
    roomService: {
      async listParticipants() { return [target]; },
      async mutePublishedTrack() {},
      async updateParticipant() {},
      async removeParticipant() {},
      async moveParticipant() { calls.push("move"); throw new Error("LiveKit move failed"); },
    },
    channelLookup(id) { return { cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" } }[id] || null; },
    presenceService: presence,
  });
  await assert.rejects(() => service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" }), /LiveKit move failed/);
  assert.deepEqual(presence.moves, [["begin", "target-id", "apex", "Apex"], ["cancel", "target-id"]]);
  assert.equal(presence.announcements.length, 0);
});

test("服务器静音只在首次成功时产生 server_muted，alreadyMuted 与 unmute 不播报", async () => {
  const { service, presence } = makeService();
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(presence.announcements.length, 1);
  assert.equal(presence.announcements[0].eventType, "server_muted");
  assert.equal(presence.announcements[0].actor.displayName, "目标成员");
  // 范围：目标所在频道 + 目标本人 + 操作者，不再全服
  assert.deepEqual(presence.announcements[0].scope, { type: "channels", channelIds: ["cs2"], includeParticipants: ["target-id", "admin-id"] });
  const again = await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(again.alreadyMuted, true);
  assert.equal(presence.announcements.length, 1);
  await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(presence.announcements.length, 1);
  await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(presence.announcements.length, 1);
});

test("播报 payload 只包含展示字段，不含敏感信息（scope 是服务器内部路由，不随消息下发）", async () => {
  const { service, presence } = makeService();
  await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  const payloads = presence.announcements.map(({ scope: _scope, ...event }) => event);
  const serialized = JSON.stringify(payloads);
  assert.doesNotMatch(serialized, /admin-id|session|token|cookie|password|secret/i);
});

// ---------- 自建 LiveKit：moveParticipant not implemented 的应用层 fallback ----------

test("isMoveNotImplementedError 只识别 Twirp not implemented，不吞其他错误", () => {
  assert.equal(isMoveNotImplementedError(twirpNotImplementedError()), true);
  assert.equal(isMoveNotImplementedError(Object.assign(new Error("x"), { code: "unimplemented" })), true);
  assert.equal(isMoveNotImplementedError(Object.assign(new Error("x"), { status: 501 })), true);
  assert.equal(isMoveNotImplementedError(null), false);
  assert.equal(isMoveNotImplementedError(new Error("unauthorized")), false);
  assert.equal(isMoveNotImplementedError(Object.assign(new Error("forbidden"), { status: 403 })), false);
  assert.equal(isMoveNotImplementedError(Object.assign(new Error("participant does not exist"), { status: 404 })), false);
  assert.equal(isMoveNotImplementedError(new Error("network timeout")), false);
  assert.equal(isMoveNotImplementedError(Object.assign(new Error("invalid API key"), { status: 401 })), false);
});

test("moveParticipant 成功时仍走原 LiveKit 路径，不发送 voice_control", async () => {
  const { service, calls, presence } = makeService();
  const result = await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.equal(result.success, true);
  assert.equal(result.movedViaFallback, false);
  assert.deepEqual(calls.find((call) => call[0] === "move"), ["move", "cs2", "target-id", "apex"]);
  assert.equal(presence.voiceControls.length, 0);
});

test("moveParticipant not implemented 时 fallback 到 Presence force_move_channel，只发给目标用户", async () => {
  const { service, presence } = makeService({ moveError: twirpNotImplementedError() });
  const result = await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.equal(result.success, true);
  assert.equal(result.movedViaFallback, true);
  assert.equal(result.targetChannelName, "Apex");
  assert.equal(presence.voiceControls.length, 1);
  const [identity, sourceChannelId, payload] = presence.voiceControls[0];
  assert.equal(identity, "target-id");
  assert.equal(sourceChannelId, "cs2");
  assert.deepEqual(payload, {
    type: "voice_control",
    action: "force_move_channel",
    requestId: "request-id",
    targetChannelId: "apex",
    targetChannelName: "Apex",
    sourceChannelId: "cs2",
    reason: "admin_move",
  });
  // 控制消息不携带 session / cookie / token / secret
  assert.doesNotMatch(JSON.stringify(payload), /session|cookie|token|secret|password/i);
});

test("fallback 移动时移动抑制窗口生效且不取消，只播一条 channel_moved", async () => {
  const { service, presence } = makeService({ moveError: twirpNotImplementedError() });
  await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.deepEqual(presence.moves, [["begin", "target-id", "apex", "Apex"]]);
  assert.equal(presence.announcements.length, 1);
  assert.equal(presence.announcements[0].eventType, "channel_moved");
  assert.equal(presence.announcements[0].channelName, "Apex");
  assert.equal(presence.announcements.some((item) => ["channel_joined", "channel_left"].includes(item.eventType)), false);
  // 范围与 LiveKit 原路径一致：源频道 + 目标频道 + 被移动者 + 操作者
  assert.deepEqual(presence.announcements[0].scope, { type: "channels", channelIds: ["cs2", "apex"], includeParticipants: ["target-id", "admin-id"] });
});

test("目标用户没有在线 Presence 连接时 fallback 返回明确失败并清理移动窗口", async () => {
  const { service, presence } = makeService({ moveError: twirpNotImplementedError(), voiceControlDelivered: false });
  const result = await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.equal(result.status, 409);
  assert.match(result.error, /没有在线连接/);
  assert.equal(result.success, undefined);
  assert.deepEqual(presence.moves, [["begin", "target-id", "apex", "Apex"], ["cancel", "target-id"]]);
  assert.equal(presence.announcements.length, 0);
});

test("非 not implemented 的 move 错误不触发 fallback，仍按失败处理", async () => {
  for (const moveError of [
    Object.assign(new Error("unauthorized"), { status: 401 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    Object.assign(new Error("participant does not exist"), { status: 404 }),
    new Error("network timeout"),
  ]) {
    const { service, presence } = makeService({ moveError });
    await assert.rejects(
      () => service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" }),
      moveError,
    );
    assert.equal(presence.voiceControls.length, 0);
    assert.deepEqual(presence.moves, [["begin", "target-id", "apex", "Apex"], ["cancel", "target-id"]]);
    assert.equal(presence.announcements.length, 0);
  }
});

test("服务器静音成员走 fallback 移动时静音记录迁移到目标频道", async () => {
  const { service } = makeService({ moveError: twirpNotImplementedError() });
  await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  const result = await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.equal(result.serverMuted, true);
  assert.equal(service.getServerMuteState("target-id").currentRoomName, "apex");
});
