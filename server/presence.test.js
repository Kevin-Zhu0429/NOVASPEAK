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

// ---------- 3B：指定事件语音播报（announcement） ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const announcementsOf = (connection) => connection.messages.filter((message) => message.type === "announcement");
const observerUser = { id: "observer-id", displayName: "OBSERVER", role: "member", isGuest: false, positions: [], positionNames: [] };
const ANNOUNCE_GRACE_MS = 25;

function createAnnouncementFixture(overrides = {}) {
  const service = createPresenceService({
    heartbeatMs: 60_000,
    autoHeartbeat: false,
    startupQuietMs: 0,
    announcementGraceMs: ANNOUNCE_GRACE_MS,
    moveWindowMs: 500,
    moveSettleMs: 60,
    channelLookup: (id) => ({ cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" } })[id] || null,
    ...overrides,
  });
  const observer = new FakeConnection();
  service.addConnection(observer, {}, observerUser);
  return { service, observer };
}

test("从 0 个连接变为 1 个连接时产生 server_joined，且初始快照不产生 announcement", () => {
  const { service, observer } = createAnnouncementFixture();
  const joining = new FakeConnection();
  service.addConnection(joining, {}, formalUser);
  const seen = announcementsOf(observer);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].eventType, "server_joined");
  assert.equal(seen[0].actor.displayName, "CHILLILY");
  assert.deepEqual(seen[0].actor.positionNames, ["队长", "狙击手"]);
  // 新连接本身没有收到任何 announcement：既不重播已有成员，也不播自己的登录
  assert.equal(announcementsOf(joining).length, 0);
  // 快照仍然正常发送且类型不同
  assert.equal(joining.messages.some((message) => message.type === "presence:snapshot"), true);
  service.close();
});

test("同账号第二个标签页连接不重复产生 server_joined", () => {
  const { service, observer } = createAnnouncementFixture();
  service.addConnection(new FakeConnection(), {}, formalUser);
  service.addConnection(new FakeConnection(), {}, formalUser);
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "server_joined").length, 1);
  service.close();
});

test("lobby → channel 产生 channel_joined，channel → lobby 在宽限期后产生 channel_left", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const joined = announcementsOf(observer).filter((item) => item.eventType === "channel_joined");
  assert.equal(joined.length, 1);
  assert.equal(joined[0].channelName, "CS2");
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  // 降级播报走宽限期，不是立刻播
  assert.equal(announcementsOf(observer).filter((item) => item.eventType === "channel_left").length, 0);
  await sleep(ANNOUNCE_GRACE_MS * 4);
  const left = announcementsOf(observer).filter((item) => item.eventType === "channel_left");
  assert.equal(left.length, 1);
  assert.equal(left[0].channelName, "CS2");
  service.close();
});

test("reconnecting 不产生 channel_left / channel_joined", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "reconnecting", channelId: "cs2" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("断线后在宽限期内重连不产生欢迎和离开/进入播报", async () => {
  const { service, observer } = createAnnouncementFixture();
  const first = new FakeConnection();
  service.addConnection(first, {}, formalUser);
  first.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  first.emit("close");
  const second = new FakeConnection();
  service.addConnection(second, {}, formalUser);
  second.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("最后一个连接断开且未重连时，宽限期后产生 channel_left", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).filter((item) => item.eventType === "channel_left").length;
  connection.emit("close");
  await sleep(ANNOUNCE_GRACE_MS * 4);
  const left = announcementsOf(observer).filter((item) => item.eventType === "channel_left");
  assert.equal(left.length, baseline + 1);
  assert.equal(left.at(-1).channelName, "CS2");
  service.close();
});

test("移动窗口内 channel1 → channel2 不播进出（含 :voice: 后缀归一化）", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  assert.equal(service.beginParticipantMove("database-id:voice:conn-123", "apex", "Apex"), true);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("移动经过 lobby 中转时也不播进出：抑制不是一次性消费", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id", "apex", "Apex");
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  await sleep(ANNOUNCE_GRACE_MS * 2);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("移动经过 reconnecting 中转时也不播进出", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id", "apex", "Apex");
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "reconnecting", channelId: "cs2" }));
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("移动经过离线中转（断开重连）时也不播进出和欢迎", async () => {
  const { service, observer } = createAnnouncementFixture();
  const first = new FakeConnection();
  service.addConnection(first, {}, formalUser);
  first.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id", "apex", "Apex");
  first.emit("close");
  const second = new FakeConnection();
  service.addConnection(second, {}, formalUser);
  second.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("服务端 setConnectionLocation 与客户端 set-location 双路径不造成重复进出播报", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id:voice:conn-9", "apex", "Apex");
  assert.equal(service.setConnectionLocation("database-id", "cs2", { state: "in_channel", channelId: "apex", channelName: "Apex" }), true);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  await sleep(ANNOUNCE_GRACE_MS * 4);
  assert.equal(announcementsOf(observer).length, baseline);
  service.close();
});

test("移动窗口过期后，普通进入/离开频道恢复正常播报", async () => {
  const { service, observer } = createAnnouncementFixture({ moveWindowMs: 30, moveSettleMs: 20 });
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id", "apex", "Apex");
  await sleep(100);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  const events = announcementsOf(observer).slice(baseline);
  assert.deepEqual(events.map((item) => item.eventType), ["channel_left", "channel_joined"]);
  service.close();
});

test("cancelParticipantMove 后恢复正常播报", async () => {
  const { service, observer } = createAnnouncementFixture();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, formalUser);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "cs2" }));
  const baseline = announcementsOf(observer).length;
  service.beginParticipantMove("database-id:voice:x", "apex", "Apex");
  assert.equal(service.cancelParticipantMove("database-id:voice:x"), true);
  connection.emit("message", JSON.stringify({ type: "presence:set-location", state: "in_channel", channelId: "apex" }));
  const events = announcementsOf(observer).slice(baseline);
  assert.deepEqual(events.map((item) => item.eventType), ["channel_left", "channel_joined"]);
  service.close();
});

test("eventId 存在且稳定唯一，payload 不包含敏感字段", () => {
  const { service, observer } = createAnnouncementFixture();
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
