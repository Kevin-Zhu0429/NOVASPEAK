import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// presence.js 顶层 import db.js，用临时数据库隔离真实数据
const testDbDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "novaspeak-membership-")
);
process.env.NOVASPEAK_DB_PATH = path.join(testDbDir, "novaspeak-test.db");
const { createPresenceService } = await import("../presence.js");
const importedDb = (await import("../db.js")).default;

test.after(async () => {
  importedDb.close();
  await fs.rm(testDbDir, { recursive: true, force: true });
});

class FakeConnection extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  send(message, callback) {
    callback?.();
  }
  ping() {}
  close() {
    this.emit("close");
  }
  terminate() {
    this.emit("close");
  }
}

const CHANNELS = {
  cs2: { id: "cs2", name: "CS2" },
  apex: { id: "apex", name: "Apex" },
};

function createService() {
  return createPresenceService({
    autoHeartbeat: false,
    channelLookup: (id) => CHANNELS[id] || null,
  });
}

function memberUser(id) {
  return { id, displayName: `成员${id}`, role: "member", isGuest: false };
}

function guestUser(id) {
  return { id, displayName: "访客", role: "guest", isGuest: true };
}

function setLocation(connection, state, channelId) {
  connection.emit(
    "message",
    JSON.stringify({ type: "presence:set-location", state, channelId }),
    false
  );
}

test("正式成员位于频道时校验通过", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("member-1"));
  setLocation(connection, "in_channel", "cs2");

  assert.equal(service.isUserInChannel("member-1", "cs2"), true);
  assert.equal(service.isUserInChannel("member-1", "apex"), false);
  service.close();
});

test("guest 位于频道时校验通过（guest:UUID 独立身份）", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, guestUser("guest:abc-123"));
  setLocation(connection, "in_channel", "cs2");

  assert.equal(service.isUserInChannel("guest:abc-123", "cs2"), true);
  assert.equal(service.isUserInChannel("guest:other", "cs2"), false);
  service.close();
});

test("lobby 状态拒绝", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("member-2"));
  // 默认即 lobby
  assert.equal(service.isUserInChannel("member-2", "cs2"), false);
  service.close();
});

test("位于其他频道时拒绝", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("member-3"));
  setLocation(connection, "in_channel", "apex");
  assert.equal(service.isUserInChannel("member-3", "cs2"), false);
  service.close();
});

test("reconnecting 且频道一致时允许短暂访问", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("member-4"));
  setLocation(connection, "reconnecting", "cs2");
  assert.equal(service.isUserInChannel("member-4", "cs2"), true);
  assert.equal(service.isUserInChannel("member-4", "apex"), false);
  service.close();
});

test("多标签页只要一个连接命中即可", () => {
  const service = createService();
  const lobbyTab = new FakeConnection();
  const channelTab = new FakeConnection();
  service.addConnection(lobbyTab, {}, memberUser("member-5"));
  service.addConnection(channelTab, {}, memberUser("member-5"));
  setLocation(channelTab, "in_channel", "cs2");

  assert.equal(service.isUserInChannel("member-5", "cs2"), true);
  service.close();
});

test("离线用户与非法参数拒绝", () => {
  const service = createService();
  assert.equal(service.isUserInChannel("nobody", "cs2"), false);
  assert.equal(service.isUserInChannel("", "cs2"), false);
  assert.equal(service.isUserInChannel("member-1", ""), false);
  assert.equal(service.isUserInChannel(null, "cs2"), false);
  service.close();
});

// ---------- hasUsersInChannel（音乐机器人听众判定）----------

test("hasUsersInChannel：in_channel 为 true", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("listener-1"));
  setLocation(connection, "in_channel", "cs2");
  assert.equal(service.hasUsersInChannel("cs2"), true);
  service.close();
});

test("hasUsersInChannel：lobby 不算听众", () => {
  const service = createService();
  service.addConnection(new FakeConnection(), {}, memberUser("listener-2"));
  assert.equal(service.hasUsersInChannel("cs2"), false);
  service.close();
});

test("hasUsersInChannel：reconnecting 不算稳定听众", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("listener-3"));
  setLocation(connection, "reconnecting", "cs2");
  assert.equal(service.hasUsersInChannel("cs2"), false);
  service.close();
});

test("hasUsersInChannel：其他频道不算", () => {
  const service = createService();
  const connection = new FakeConnection();
  service.addConnection(connection, {}, memberUser("listener-4"));
  setLocation(connection, "in_channel", "apex");
  assert.equal(service.hasUsersInChannel("cs2"), false);
  service.close();
});

test("hasUsersInChannel：多标签页一个命中即可；非法参数 false", () => {
  const service = createService();
  const lobbyTab = new FakeConnection();
  const channelTab = new FakeConnection();
  service.addConnection(lobbyTab, {}, memberUser("listener-5"));
  service.addConnection(channelTab, {}, memberUser("listener-5"));
  setLocation(channelTab, "in_channel", "cs2");
  assert.equal(service.hasUsersInChannel("cs2"), true);
  assert.equal(service.hasUsersInChannel(""), false);
  assert.equal(service.hasUsersInChannel(null), false);
  service.close();
});
