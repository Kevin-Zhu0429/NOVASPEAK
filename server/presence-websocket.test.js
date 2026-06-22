import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productionDbPath = path.resolve(__dirname, "data", "novaspeak.db");
const importDbDir = await fs.mkdtemp(path.join(os.tmpdir(), "novaspeak-presence-import-"));
const importDbPath = path.join(importDbDir, "novaspeak-test.db");
assert.notEqual(path.resolve(importDbPath), productionDbPath);
process.env.NOVASPEAK_DB_PATH = importDbPath;
const { createPresenceService } = await import("./presence.js");
const importedDb = (await import("./db.js")).default;

test.after(async () => {
  importedDb.close();
  await fs.rm(importDbDir, { recursive: true, force: true });
});

const identities = {
  admin: {
    id: "admin-id", displayName: "ADMIN01", role: "admin", isGuest: false,
    positions: ["captain"], positionNames: ["队长"],
  },
  member: {
    id: "member-id", displayName: "PLAYER01", role: "member", isGuest: false,
    positions: ["member"], positionNames: ["队员"],
  },
  guest: {
    id: "guest:test-uuid", displayName: "TEMP01", role: "guest", isGuest: true,
    positions: [], positionNames: [],
  },
};

function cookieIdentity(req) {
  const match = /(?:^|;\s*)test_identity=([^;]+)/.exec(req.headers.cookie || "");
  return identities[match?.[1]] || null;
}

async function createTestDatabase() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novaspeak-presence-ws-"));
  const dbPath = path.join(dir, "novaspeak-test.db");
  assert.notEqual(path.resolve(dbPath), productionDbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL, position TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, owner_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE user_positions (user_id TEXT NOT NULL, position TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, position), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  `);
  const now = Date.now();
  db.prepare("INSERT INTO users (id, username, username_key, display_name, password_hash, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("admin-id", "ADMIN01", "admin01", "ADMIN01", "test-hash", "admin", "captain", now);
  db.prepare("INSERT INTO users (id, username, username_key, display_name, password_hash, role, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("member-id", "PLAYER01", "player01", "PLAYER01", "test-hash", "member", "member", now);
  db.prepare("INSERT INTO user_positions (user_id, position) VALUES (?, ?)").run("admin-id", "captain");
  db.prepare("INSERT INTO user_positions (user_id, position) VALUES (?, ?)").run("member-id", "member");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run("admin-session", "admin-id", now + 3600000, now);
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run("member-session", "member-id", now + 3600000, now);
  db.prepare("INSERT INTO channels (id, name, name_key, is_default, created_at) VALUES (?, ?, ?, ?, ?)").run("cs2", "服务器 CS2", "cs2", 1, now);
  db.prepare("INSERT INTO channels (id, name, name_key, is_default, created_at) VALUES (?, ?, ?, ?, ?)").run("apex", "服务器 Apex", "apex", 1, now);
  return { db, dbPath, dir };
}

async function createFixture(options = {}) {
  const testDb = await createTestDatabase();
  const presence = createPresenceService({
    heartbeatMs: options.heartbeatMs ?? 60_000,
    autoHeartbeat: options.autoHeartbeat ?? false,
    authResolver: options.authResolver ?? cookieIdentity,
    channelLookup: (id) => testDb.db.prepare("SELECT id, name FROM channels WHERE id = ?").get(id),
  });
  const server = createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!presence.handleUpgrade(req, socket, head)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const clients = new Set();
  return {
    presence,
    dbPath: testDb.dbPath,
    presenceDbPath: importDbPath,
    findChannelById: (id) => testDb.db.prepare("SELECT id, name FROM channels WHERE id = ?").get(id),
    url: `ws://127.0.0.1:${port}`,
    track: (ws) => {
      clients.add(ws);
      ws.once("close", () => clients.delete(ws));
      return ws;
    },
    close: async () => {
      presence.close();
      for (const ws of clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
      testDb.db.close();
      await fs.rm(testDb.dir, { recursive: true, force: true });
    },
  };
}

function connect(fixture, identity, socketPath = "/ws/presence") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${fixture.url}${socketPath}`, {
      headers: identity ? { Cookie: `test_identity=${identity}` } : undefined,
    });
    ws.once("open", () => resolve(fixture.track(ws)));
    ws.once("error", reject);
  });
}

function summarizeMessages(messages) {
  return messages.map((message) => ({
    type: message.type,
    error: message.error,
    members: message.members?.map((member) => ({
      nickname: member.nickname,
      state: member.state,
      channelId: member.channelId,
      channelName: member.channelName,
      deviceCount: member.deviceCount,
    })),
  }));
}

function waitForMessage(ws, predicate, { timeout = 1000 } = {}) {
  const seen = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for message; seen=${JSON.stringify(summarizeMessages(seen))}`));
    }, timeout);
    const onMessage = (data) => {
      try {
        const value = JSON.parse(data.toString());
        seen.push(value);
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`socket closed before message: ${code}; seen=${JSON.stringify(summarizeMessages(seen))}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

function waitFor(predicate, { timeout = 1000, interval = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeout) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, interval);
    };
    check();
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({
    code, reason: reason.toString(),
  })));
}

test("upgrade authentication accepts all roles and rejects missing or forged identity", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  assert.notEqual(path.resolve(fixture.dbPath), productionDbPath);

  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${fixture.url}/ws/presence?role=admin`);
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("error", reject);
  });
  assert.equal(status, 401);

  for (const identity of ["admin", "member", "guest"]) {
    const ws = await connect(fixture, identity);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
    await waitForClose(ws);
  }

  const otherPathStatus = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${fixture.url}/ws/other`, {
      headers: { Cookie: "test_identity=admin" },
    });
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("error", reject);
  });
  assert.equal(otherPathStatus, 404);
});

test("real clients preserve message validation, fragmentation, aggregation, and receiver-specific snapshots", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);
  const admin = await connect(fixture, "admin");
  const member = await connect(fixture, "member");
  const adminSecondDevice = await connect(fixture, "admin");

  const adminSnapshotPromise = waitForMessage(admin, (message) =>
    message.type === "presence:snapshot" && message.members.length === 2);
  const memberSnapshotPromise = waitForMessage(member, (message) =>
    message.type === "presence:snapshot" && message.members.length === 2);
  adminSecondDevice.send(JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  const [adminSnapshot, memberSnapshot] = await Promise.all([adminSnapshotPromise, memberSnapshotPromise]);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "ADMIN01").isCurrentUser, true);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "PLAYER01").isCurrentUser, false);
  assert.equal(memberSnapshot.members.find((item) => item.nickname === "ADMIN01").isCurrentUser, false);
  assert.equal(memberSnapshot.members.find((item) => item.nickname === "PLAYER01").isCurrentUser, true);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "ADMIN01").deviceCount, 2);
  assert.doesNotMatch(JSON.stringify(adminSnapshot), /admin-id|member-id|session|cookie/i);

  const expectedChannel = { id: "cs2", name: "服务器 CS2" };
  console.log(`presence module DB path=${fixture.presenceDbPath}; fixture DB path=${fixture.dbPath}`);
  assert.deepEqual(await fixture.findChannelById("cs2"), expectedChannel,
    `presence module DB path=${fixture.presenceDbPath}; fixture DB path=${fixture.dbPath}`);
  const expectedMessage = {
    type: "presence:set-location", state: "in_channel", channelId: "cs2",
    nickname: "FORGED", role: "guest", positions: ["captain"],
  };
  const update = JSON.stringify(expectedMessage);
  const updatedPromise = waitForMessage(admin, (message) => {
    if (message.type !== "presence:snapshot") return false;
    const player = message.members.find((item) => item.nickname === "PLAYER01");
    return player?.state === "in_channel" && player?.channelId === "cs2" && player?.channelName === "服务器 CS2";
  });
  const firstPart = update.slice(0, 20);
  const secondPart = update.slice(20);
  assert.deepEqual(JSON.parse(firstPart + secondPart), expectedMessage);
  member.send(firstPart, { fin: false, binary: false, compress: false });
  member.send(secondPart, { fin: true, binary: false, compress: false });
  const updated = await updatedPromise;
  const player = updated.members.find((item) => item.nickname === "PLAYER01");
  assert.equal(player.roleLabel, "成员");
  assert.deepEqual(player.positions, ["member"]);
  assert.equal(player.channelId, "cs2");
  await waitFor(() => {
    const current = fixture.presence.publicMembers("user:member-id");
    return current.find((item) => item.nickname === "PLAYER01")?.channelId === "cs2";
  });

  const errorPromise = waitForMessage(member, (message) => message.type === "presence:error");
  member.send("{malformed");
  assert.equal((await errorPromise).error, "消息不是有效 JSON");

  const invalidChannelError = waitForMessage(member, (message) =>
    message.type === "presence:error" && message.error === "频道不存在");
  member.send(JSON.stringify({
    type: "presence:set-location", state: "in_channel", channelId: "missing",
  }));
  await invalidChannelError;
  const memberAfterInvalidChannel = fixture.presence.publicMembers("user:member-id")
    .find((item) => item.nickname === "PLAYER01");
  assert.equal(memberAfterInvalidChannel.channelId, "cs2");

  const unknownMessageError = waitForMessage(member, (message) =>
    message.type === "presence:error" && message.error === "无效的在线状态消息");
  member.send(JSON.stringify({ type: "presence:unknown", state: "lobby" }));
  await unknownMessageError;

  for (let index = 0; index < 10; index += 1) {
    member.send(JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  }
  await waitForMessage(member, (message) =>
    message.type === "presence:snapshot" &&
    message.members.find((item) => item.nickname === "PLAYER01")?.state === "lobby");
});

test("binary and oversized messages are closed by the ws transport", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const binary = await connect(fixture, "member");
  const binaryClose = waitForClose(binary);
  binary.send(Buffer.from([1, 2, 3]));
  assert.equal((await binaryClose).code, 1003);

  const oversized = await connect(fixture, "member");
  const oversizedClose = waitForClose(oversized);
  oversized.send("x".repeat(4097));
  assert.equal((await oversizedClose).code, 1009);
});

test("normal close, terminate, heartbeat, and identity invalidation clean up Presence", async (t) => {
  let valid = true;
  const fixture = await createFixture({
    heartbeatMs: 60_000,
    authResolver: (req) => valid ? cookieIdentity(req) : null,
  });
  t.after(fixture.close);

  const normal = await connect(fixture, "admin");
  const secondNormal = await connect(fixture, "admin");
  assert.equal(fixture.presence.publicMembers("user:admin-id")[0].deviceCount, 2);
  const normalClose = waitForClose(normal);
  normal.close();
  await normalClose;
  await waitFor(() => fixture.presence.publicMembers("user:admin-id")[0]?.deviceCount === 1);
  assert.equal(fixture.presence.publicMembers("user:admin-id")[0].deviceCount, 1);
  const secondNormalClose = waitForClose(secondNormal);
  secondNormal.close();
  await secondNormalClose;
  await waitFor(() => fixture.presence.publicMembers("user:admin-id").length === 0);

  const abnormal = await connect(fixture, "member");
  const abnormalClose = waitForClose(abnormal);
  abnormal.terminate();
  await abnormalClose;
  await waitFor(() => fixture.presence.publicMembers("user:member-id").length === 0);

  const expiring = await connect(fixture, "guest");
  assert.equal([...fixture.presence.principals.get("guest:test-uuid").connections.keys()][0].isAlive, true);
  valid = false;
  const closed = waitForClose(expiring);
  await fixture.presence.runIdentityRevalidation();
  assert.equal((await closed).code, 4401);
  await waitFor(() => fixture.presence.publicMembers("guest:test-uuid").length === 0);
});

test("heartbeat keeps responsive ws clients and terminates explicitly stale connections", async (t) => {
  const fixture = await createFixture({ heartbeatMs: 60_000 });
  t.after(fixture.close);
  const responsive = await connect(fixture, "admin");
  const principal = fixture.presence.principals.get("user:admin-id");
  const [responsiveServerWs] = principal.connections.keys();
  const pong = new Promise((resolve) => responsiveServerWs.once("pong", resolve));
  assert.equal(responsiveServerWs.isAlive, true);
  await fixture.presence.runTransportHeartbeatCheck();
  assert.equal(responsiveServerWs.isAlive, false);
  await pong;
  assert.equal(responsiveServerWs.isAlive, true);
  const nextPong = new Promise((resolve) => responsiveServerWs.once("pong", resolve));
  await fixture.presence.runTransportHeartbeatCheck();
  await nextPong;
  await waitFor(() => fixture.presence.publicMembers("user:admin-id").length === 1);
  assert.equal(responsive.readyState, WebSocket.OPEN);

  const unresponsive = await connect(fixture, "member");
  const stalePrincipal = fixture.presence.principals.get("user:member-id");
  const serverConnection = [...stalePrincipal.connections.keys()][0];
  serverConnection.isAlive = false;
  assert.equal(serverConnection.isAlive, false);
  const closed = waitForClose(unresponsive);
  await fixture.presence.runTransportHeartbeatCheck();
  assert.equal((await closed).code, 1006);
  await waitFor(() => fixture.presence.publicMembers("user:member-id").length === 0);
});
