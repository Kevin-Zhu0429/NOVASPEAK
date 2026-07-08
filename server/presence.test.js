import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productionDbPath = path.resolve(__dirname, "data", "novaspeak.db");
const testDbDir = await fs.mkdtemp(path.join(os.tmpdir(), "novaspeak-presence-unit-"));
const testDbPath = path.join(testDbDir, "novaspeak-test.db");
assert.notEqual(path.resolve(testDbPath), productionDbPath);
process.env.NOVASPEAK_DB_PATH = testDbPath;
const { aggregateConnections, createPresenceService } = await import("./presence.js");
const importedDb = (await import("./db.js")).default;

test.after(async () => {
  importedDb.close();
  await fs.rm(testDbDir, { recursive: true, force: true });
});

const connectionMap = (...states) => new Map(states.map((state, index) => [{ index }, state]));

test("all connections default to lobby", () => {
  assert.deepEqual(aggregateConnections(connectionMap(
    { state: "lobby", channelId: null, channelName: "大厅" },
    { state: "lobby", channelId: null, channelName: "大厅" },
  )), { state: "lobby", channelId: null, channelName: "大厅" });
});

test("an active channel takes priority over lobby and reconnecting", () => {
  assert.equal(aggregateConnections(connectionMap(
    { state: "lobby" },
    { state: "reconnecting", channelId: "cs2", channelName: "CS2" },
    { state: "in_channel", channelId: "apex", channelName: "Apex" },
  )).channelId, "apex");
});

test("different active channels aggregate to multi_channel", () => {
  assert.deepEqual(aggregateConnections(connectionMap(
    { state: "in_channel", channelId: "cs2", channelName: "CS2" },
    { state: "in_channel", channelId: "apex", channelName: "Apex" },
  )), { state: "multi_channel", channelId: null, channelName: "多个频道" });
});

test("all channel connections reconnecting aggregate to reconnecting", () => {
  assert.equal(aggregateConnections(connectionMap(
    { state: "reconnecting", channelId: "cs2", channelName: "CS2" },
    { state: "reconnecting", channelId: "cs2", channelName: "CS2" },
  )).state, "reconnecting");
});

class FakeConnection extends EventEmitter {
  messages = [];
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  send(message, callback) {
    this.messages.push(JSON.parse(message));
    callback?.();
  }
  ping() {}
  close(code) {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

const formalUser = {
  id: "database-id",
  displayName: "CHILLILY",
  role: "admin",
  isGuest: false,
  positions: ["captain", "sniper"],
  positionNames: ["队长", "狙击手"],
};

test("connections aggregate safely and channel names come from the server", () => {
  const service = createPresenceService({
    heartbeatMs: 60_000,
    channelLookup: (id) => id === "cs2" ? { id, name: "服务器 CS2" } : null,
  });
  const first = new FakeConnection();
  const second = new FakeConnection();
  service.addConnection(first, {}, formalUser);
  service.addConnection(second, {}, formalUser);
  first.emit("message", JSON.stringify({
    type: "presence:set-location",
    state: "in_channel",
    channelId: "cs2",
    nickname: "伪造昵称",
    role: "guest",
    positions: ["member"],
  }));
  const member = service.publicMembers("user:database-id")[0];
  assert.equal(service.publicMembers("user:database-id").length, 1);
  assert.equal(member.deviceCount, 2);
  assert.equal(member.nickname, "CHILLILY");
  assert.equal(member.roleLabel, "管理员");
  assert.deepEqual(member.positions, ["captain", "sniper"]);
  assert.equal(member.channelName, "服务器 CS2");
  assert.equal(member.isCurrentUser, true);
  assert.equal(JSON.stringify(member).includes("database-id"), false);
  assert.equal(JSON.stringify(member).includes("session"), false);
  service.close();
});

test("invalid channels are rejected without changing location", () => {
  const service = createPresenceService({ heartbeatMs: 60_000, channelLookup: () => null });
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({
    type: "presence:set-location", state: "in_channel", channelId: "missing",
  }));
  assert.equal(connection.messages.at(-1).type, "presence:error");
  assert.equal(service.publicMembers("user:database-id")[0].state, "lobby");
  service.close();
});

test("last disconnect removes a member while one remaining device keeps it online", () => {
  const service = createPresenceService({ heartbeatMs: 60_000 });
  const first = new FakeConnection();
  const second = new FakeConnection();
  service.addConnection(first, {}, formalUser);
  service.addConnection(second, {}, formalUser);
  first.emit("close");
  assert.equal(service.publicMembers("user:database-id")[0].deviceCount, 1);
  second.emit("close");
  assert.equal(service.publicMembers("user:database-id").length, 0);
  service.close();
});

test("guest has a separate authenticated principal and safe public profile", () => {
  const service = createPresenceService({ heartbeatMs: 60_000 });
  const connection = new FakeConnection();
  service.addConnection(connection, {}, {
    id: "guest:private-uuid", displayName: "TEMP01", role: "guest", isGuest: true,
  });
  const member = service.publicMembers("guest:private-uuid")[0];
  assert.equal(member.nickname, "TEMP01");
  assert.equal(member.isGuest, true);
  assert.equal(member.roleLabel, "访客");
  assert.equal(JSON.stringify(member).includes("private-uuid"), false);
  service.close();
});

// ---------- 3B：指定事件语音播报（announcement，按频道范围投递） ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const announcementsOf = (connection) => connection.messages.filter((message) => message.type === "announcement");
const ANNOUNCE_GRACE_MS = 25;

function createAnnouncementFixture(overrides = {}) {
  const service = createPresenceService({
    heartbeatMs: 60_000,
    autoHeartbeat: false,
    startupQuietMs: 0,
    announcementGraceMs: ANNOUNCE_GRACE_MS,
    moveWindowMs: 500,
    moveSettleMs: 60,
    channelLookup: (id) => ({ cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" }, ow: { id: "ow", name: "OW" } })[id] || null,
    ...overrides,
  });
  const users = {};
  const join = (userId, channelId = null) => {
    const connection = new FakeConnection();
    const user = users[userId] || { id: userId, displayName: userId.toUpperCase(), role: "member", isGuest: false, positions: [], positionNames: [] };
    service.addConnection(connection, {}, user);
    if (channelId) connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId }));
    return connection;
  };
  const baselineOf = (connections) => connections.map((connection) => announcementsOf(connection).length);
  const newEventsOf = (connections, baseline) => connections.map((connection, index) => announcementsOf(connection).slice(baseline[index]).map((item) => item.eventType));
  return { service, join, baselineOf, newEventsOf };
}

test("server_joined 仍然全服播报（含大厅用户），初始快照不产生 announcement", () => {
  const { service, join } = createAnnouncementFixture();
  const lobbyObserver = join("observer-lobby");
  const channelObserver = join("observer-cs2", "cs2");
  const joining = new FakeConnection();
  service.addConnection(joining, {}, formalUser);
  const lobbySeen = announcementsOf(lobbyObserver).filter((item) => item.eventType === "server_joined");
  assert.equal(lobbySeen.length, 2);
  assert.equal(lobbySeen.at(-1).actor.displayName, "CHILLILY");
  assert.deepEqual(lobbySeen.at(-1).actor.positionNames, ["队长", "狙击手"]);
  assert.equal(announcementsOf(channelObserver).filter((item) => item.eventType === "server_joined").length, 1);
  // 新连接本身没有收到任何 announcement：既不重播已有成员，也不播自己的登录
  assert.equal(announcementsOf(joining).length, 0);
  assert.equal(joining.messages.some((message) => message.type === "presence:snapshot"), true);
  service.close();
});

test("同账号第二个标签页连接不重复产生 server_joined", () => {
  const { service, join } = createAnnouncementFixture();
  const observer = join("observer-lobby");
  service.addConnection(new FakeConnection(), {}, formalUser);
  service.addConnection(new FakeConnection(), {}, formalUser);
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 1);
  service.close();
});

test("手动切频道：原频道收到 left，目标频道收到 joined，无关频道和大厅收不到", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const lobbyObserver = join("observer-lobby");
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const unrelatedObserver = join("observer-ow", "ow");
  const mover = join("database-id", "cs2");
  const all = [lobbyObserver, sourceObserver, targetObserver, unrelatedObserver, mover];
  const baseline = baselineOf(all);
  mover.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [
    [],                                  // 大厅用户收不到频道事件
    ["channel_left"],                    // 原频道只收到离开
    ["channel_joined"],                  // 目标频道只收到进入
    [],                                  // 无关频道收不到
    [],                                  // 事件本人不收自己的进出
  ]);
  service.close();
});

test("channel → lobby：明确手动离开立即向原频道其他人发送 channel_left", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const unrelatedObserver = join("observer-ow", "ow");
  const lobbyObserver = join("observer-lobby");
  const leaver = join("database-id", "cs2");
  const all = [sourceObserver, unrelatedObserver, lobbyObserver];
  const baseline = baselineOf(all);
  leaver.emit("message", JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  const events = newEventsOf(all, baseline);
  assert.deepEqual(events, [["channel_left"], [], []]);
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [["channel_left"], [], []]);
  const left = announcementsOf(sourceObserver).at(-1);
  assert.equal(left.channelName, "CS2");
  service.close();
});


test("独自手动离开不缓存旧 left，之后加入其他频道不发给本人", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const targetObserver = join("observer-apex", "apex");
  const leaver = join("database-id", "cs2");
  const baselineSoloLeave = baselineOf([leaver]);
  leaver.emit("message", JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  assert.deepEqual(newEventsOf([leaver], baselineSoloLeave), [[]]);
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf([leaver], baselineSoloLeave), [[]]);

  const baselineJoin = baselineOf([targetObserver, leaver]);
  leaver.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  assert.deepEqual(newEventsOf([targetObserver, leaver], baselineJoin), [["channel_joined"], []]);
  service.close();
});

test("channel → offline 仍保留宽限期，不立即播 channel_left", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const leaver = join("database-id", "cs2");
  const baseline = baselineOf([sourceObserver]);
  leaver.emit("close");
  assert.deepEqual(newEventsOf([sourceObserver], baseline), [[]]);
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf([sourceObserver], baseline), [["channel_left"]]);
  service.close();
});

test("reconnecting 不产生 channel_left / channel_joined", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const subject = join("database-id", "cs2");
  const all = [sourceObserver, subject];
  const baseline = baselineOf(all);
  subject.emit("message", JSON.stringify({ type: "presence:set-location", state: "reconnecting", channelId: "cs2" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  subject.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [[], []]);
  service.close();
});

test("断线后在宽限期内重连不产生欢迎和离开/进入播报", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const first = join("database-id", "cs2");
  const all = [sourceObserver];
  const baseline = baselineOf(all);
  first.emit("close");
  const second = join("database-id", "cs2");
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [[]]);
  assert.equal(announcementsOf(second).length, 0);
  service.close();
});

test("最后一个连接断开且未重连时，宽限期后原频道收到 channel_left", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const unrelatedObserver = join("observer-ow", "ow");
  const leaver = join("database-id", "cs2");
  const all = [sourceObserver, unrelatedObserver];
  const baseline = baselineOf(all);
  leaver.emit("close");
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [["channel_left"], []]);
  service.close();
});

test("移动窗口内 channel1 → channel2 不播进出（含 :voice: 后缀归一化）", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const mover = join("database-id", "cs2");
  const all = [sourceObserver, targetObserver, mover];
  const baseline = baselineOf(all);
  assert.equal(service.beginParticipantMove("database-id:voice:conn-123", "apex", "Apex"), true);
  mover.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [[], [], []]);
  service.close();
});

test("移动经过 lobby / reconnecting / 离线中转时也不播进出：抑制不是一次性消费", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const viaLobby = join("database-id", "cs2");
  const all = [sourceObserver, targetObserver];
  const baseline = baselineOf(all);
  service.beginParticipantMove("database-id", "apex", "Apex");
  viaLobby.emit("message", JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  viaLobby.emit("message", JSON.stringify({ type: "presence:set-location", state: "reconnecting", channelId: "apex" }));
  viaLobby.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [[], []]);
  // 离线中转
  const baseline2 = baselineOf(all);
  service.beginParticipantMove("database-id", "cs2", "CS2");
  viaLobby.emit("close");
  const rejoined = join("database-id", "cs2");
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline2), [[], []]);
  assert.equal(announcementsOf(rejoined).length, 0);
  service.close();
});

test("服务端 setConnectionLocation 与客户端 set-location 双路径不造成重复进出播报", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture();
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const mover = join("database-id", "cs2");
  const all = [sourceObserver, targetObserver, mover];
  const baseline = baselineOf(all);
  service.beginParticipantMove("database-id:voice:conn-9", "apex", "Apex");
  assert.equal(service.setConnectionLocation("database-id", "cs2", { state: "in_channel", channelId: "apex", channelName: "Apex" }), true);
  mover.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.deepEqual(newEventsOf(all, baseline), [[], [], []]);
  service.close();
});

test("移动窗口过期或取消后，普通进入/离开频道恢复正常播报", async () => {
  const { service, join, baselineOf, newEventsOf } = createAnnouncementFixture({ moveWindowMs: 30, moveSettleMs: 20 });
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const mover = join("database-id", "cs2");
  const all = [sourceObserver, targetObserver, mover];
  const baseline = baselineOf(all);
  service.beginParticipantMove("database-id", "apex", "Apex");
  await sleep(100);
  mover.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  assert.deepEqual(newEventsOf(all, baseline), [["channel_left"], ["channel_joined"], []]);
  const baseline2 = baselineOf(all);
  service.beginParticipantMove("database-id:voice:x", "cs2", "CS2");
  assert.equal(service.cancelParticipantMove("database-id:voice:x"), true);
  mover.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  assert.deepEqual(newEventsOf(all, baseline2), [["channel_joined"], ["channel_left"], []]);
  service.close();
});

test("channels scope：源+目标频道及本人收到，无关频道和大厅收不到", () => {
  const { service, join } = createAnnouncementFixture();
  const lobbyObserver = join("observer-lobby");
  const sourceObserver = join("observer-cs2", "cs2");
  const targetObserver = join("observer-apex", "apex");
  const unrelatedObserver = join("observer-ow", "ow");
  const subjectInLobby = join("subject-id");
  const payload = service.broadcastAnnouncement(
    { eventType: "channel_moved", actor: { displayName: "SUBJECT" }, channelId: "apex", channelName: "Apex" },
    { type: "channels", channelIds: ["cs2", "apex"], includeParticipants: ["subject-id:voice:conn-1"] },
  );
  assert.equal(typeof payload.eventId, "string");
  const received = (connection) => announcementsOf(connection).some((item) => item.eventType === "channel_moved");
  assert.equal(received(lobbyObserver), false);
  assert.equal(received(sourceObserver), true);
  assert.equal(received(targetObserver), true);
  assert.equal(received(unrelatedObserver), false);
  assert.equal(received(subjectInLobby), true);
  service.close();
});

test("同账号多标签页在不同频道时，只有相关频道的标签页收到", () => {
  const { service, join } = createAnnouncementFixture();
  const tabInCs2 = join("multi-user", "cs2");
  const tabInApex = new FakeConnection();
  service.addConnection(tabInApex, {}, { id: "multi-user", displayName: "MULTI", role: "member", isGuest: false, positions: [], positionNames: [] });
  tabInApex.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  const baselineCs2 = announcementsOf(tabInCs2).length;
  const baselineApex = announcementsOf(tabInApex).length;
  service.broadcastAnnouncement(
    { eventType: "server_muted", actor: { displayName: "TARGET" }, channelId: "cs2", channelName: "CS2" },
    { type: "channels", channelIds: ["cs2"] },
  );
  assert.equal(announcementsOf(tabInCs2).length, baselineCs2 + 1);
  assert.equal(announcementsOf(tabInApex).length, baselineApex);
  service.close();
});

test("reconnecting 连接不被当作频道匹配，includeParticipants 例外仍可送达", () => {
  const { service, join } = createAnnouncementFixture();
  const reconnecting = join("recon-user", "cs2");
  reconnecting.emit("message", JSON.stringify({ type: "presence:set-location", state: "reconnecting", channelId: "cs2" }));
  const baseline = announcementsOf(reconnecting).length;
  service.broadcastAnnouncement(
    { eventType: "server_muted", actor: { displayName: "TARGET" }, channelId: "cs2", channelName: "CS2" },
    { type: "channels", channelIds: ["cs2"] },
  );
  assert.equal(announcementsOf(reconnecting).length, baseline);
  service.broadcastAnnouncement(
    { eventType: "server_muted", actor: { displayName: "TARGET" }, channelId: "cs2", channelName: "CS2" },
    { type: "channels", channelIds: ["cs2"], includeParticipants: ["recon-user"] },
  );
  assert.equal(announcementsOf(reconnecting).length, baseline + 1);
  service.close();
});

// ---------- voice_control：自建 LiveKit 移动 fallback 的定向控制消息 ----------

const voiceControlsOf = (connection) => connection.messages.filter((message) => message.type === "voice_control");

test("sendVoiceControlToParticipant 只发给目标用户，优先源频道标签页，无关用户收不到", () => {
  const { service, join } = createAnnouncementFixture();
  const observer = join("observer-cs2", "cs2");
  const targetVoiceTab = join("target-user", "cs2");
  const targetLobbyTab = join("target-user");
  const payload = {
    type: "voice_control", action: "force_move_channel", requestId: "req-1",
    targetChannelId: "apex", targetChannelName: "Apex", sourceChannelId: "cs2", reason: "admin_move",
  };
  // LiveKit identity 带 :voice: 后缀也能归一化到目标用户
  assert.equal(service.sendVoiceControlToParticipant("target-user:voice:conn-1", "cs2", payload), true);
  assert.equal(voiceControlsOf(targetVoiceTab).length, 1);
  assert.deepEqual(voiceControlsOf(targetVoiceTab)[0], payload);
  assert.equal(voiceControlsOf(targetLobbyTab).length, 0);
  assert.equal(voiceControlsOf(observer).length, 0);
  service.close();
});

test("目标用户没有源频道标签页时发给其全部连接；完全不在线返回 false", () => {
  const { service, join } = createAnnouncementFixture();
  const lobbyOnlyTab = join("target-user");
  assert.equal(service.sendVoiceControlToParticipant("target-user", "cs2", { type: "voice_control", action: "force_move_channel", targetChannelId: "apex" }), true);
  assert.equal(voiceControlsOf(lobbyOnlyTab).length, 1);
  assert.equal(service.sendVoiceControlToParticipant("offline-user", "cs2", { type: "voice_control", action: "force_move_channel", targetChannelId: "apex" }), false);
  assert.equal(service.sendVoiceControlToParticipant("", "cs2", { type: "voice_control" }), false);
  service.close();
});

// ---------- server_joined：启动静默窗口与 fresh 声明 ----------

test("启动静默窗口内：声明 fresh 的真实新登录仍播欢迎，未声明的重连不播", () => {
  const { service, join } = createAnnouncementFixture({ startupQuietMs: 60_000 });
  const observer = join("observer-lobby");
  // 未声明 fresh（重启后的自动重连、旧客户端）：静默窗口内不播欢迎
  service.addConnection(new FakeConnection(), {}, { id: "resumed-user", displayName: "RESUMED", role: "member", isGuest: false, positions: [], positionNames: [] });
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 0);
  // 声明 fresh 的新登录：穿透静默窗口，其他在线用户能听到欢迎，本人不收
  const joining = new FakeConnection();
  service.addConnection(joining, { presenceClaimsFreshLogin: true }, formalUser);
  const heard = announcementsOf(observer).filter((item) => item.eventType === "server_joined");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].actor.displayName, "CHILLILY");
  assert.equal(announcementsOf(joining).length, 0);
  service.close();
});

test("宽限期内重连即使声明 fresh 也不重复播欢迎（刷新 / 短断线安全）", async () => {
  const { service, join } = createAnnouncementFixture();
  const observer = join("observer-lobby");
  const first = new FakeConnection();
  service.addConnection(first, { presenceClaimsFreshLogin: true }, formalUser);
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 1);
  first.emit("close");
  service.addConnection(new FakeConnection(), { presenceClaimsFreshLogin: true }, formalUser);
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 1);
  service.close();
});

test("server_joined 不被移动抑制窗口影响", () => {
  const { service, join } = createAnnouncementFixture();
  const observer = join("observer-lobby");
  service.beginParticipantMove("database-id:voice:conn-1", "apex", "Apex");
  service.addConnection(new FakeConnection(), {}, formalUser);
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 1);
  service.close();
});

test("eventId 存在且稳定唯一，payload 不包含敏感字段", () => {
  const { service, join } = createAnnouncementFixture();
  const observer = join("observer-lobby");
  const first = service.broadcastAnnouncement({ eventType: "channel_moved", actor: { displayName: "CHILLILY" }, channelId: "cs2", channelName: "CS2" });
  const second = service.broadcastAnnouncement({ eventType: "server_muted", actor: { displayName: "CHILLILY" }, channelId: "cs2", channelName: "CS2" });
  assert.equal(typeof first.eventId, "string");
  assert.ok(first.eventId.length > 0);
  assert.notEqual(first.eventId, second.eventId);
  assert.equal(service.broadcastAnnouncement({ eventType: "hacked", actor: { displayName: "X" } }), null);
  const serialized = JSON.stringify(announcementsOf(observer));
  assert.doesNotMatch(serialized, /database-id|observer-id|session|token|cookie|password|@/i);
  service.close();
});
