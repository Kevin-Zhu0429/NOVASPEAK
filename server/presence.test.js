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
