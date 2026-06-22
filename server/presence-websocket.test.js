import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { createPresenceService } from "./presence.js";

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

async function createFixture(options = {}) {
  const presence = createPresenceService({
    heartbeatMs: options.heartbeatMs ?? 60_000,
    authResolver: options.authResolver ?? cookieIdentity,
    channelLookup: (id) => id === "cs2" ? { id, name: "服务器 CS2" } : null,
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
  return {
    presence,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      presence.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function connect(url, identity, path = "/ws/presence") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}${path}`, {
      headers: identity ? { Cookie: `test_identity=${identity}` } : undefined,
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      try {
        const value = JSON.parse(data.toString());
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
      reject(new Error(`socket closed before message: ${code}`));
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
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

  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${fixture.url}/ws/presence?role=admin`);
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("error", reject);
  });
  assert.equal(status, 401);

  for (const identity of ["admin", "member", "guest"]) {
    const ws = await connect(fixture.url, identity);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
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
  const admin = await connect(fixture.url, "admin");
  const member = await connect(fixture.url, "member");
  const adminSecondDevice = await connect(fixture.url, "admin");
  t.after(() => {
    admin.terminate();
    member.terminate();
    adminSecondDevice.terminate();
  });

  const adminSnapshotPromise = nextMessage(admin, (message) =>
    message.type === "presence:snapshot" && message.members.length === 2);
  const memberSnapshotPromise = nextMessage(member, (message) =>
    message.type === "presence:snapshot" && message.members.length === 2);
  adminSecondDevice.send(JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  const [adminSnapshot, memberSnapshot] = await Promise.all([adminSnapshotPromise, memberSnapshotPromise]);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "ADMIN01").isCurrentUser, true);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "PLAYER01").isCurrentUser, false);
  assert.equal(memberSnapshot.members.find((item) => item.nickname === "ADMIN01").isCurrentUser, false);
  assert.equal(memberSnapshot.members.find((item) => item.nickname === "PLAYER01").isCurrentUser, true);
  assert.equal(adminSnapshot.members.find((item) => item.nickname === "ADMIN01").deviceCount, 2);
  assert.doesNotMatch(JSON.stringify(adminSnapshot), /admin-id|member-id|session|cookie/i);

  const update = JSON.stringify({
    type: "presence:set-location", state: "in_channel", channelId: "cs2",
    nickname: "FORGED", role: "guest", positions: ["captain"],
  });
  const updatedPromise = nextMessage(admin, (message) =>
    message.members?.some((item) => item.nickname === "PLAYER01" && item.channelName === "服务器 CS2"));
  member.send(update.slice(0, 20), { fin: false });
  member.send(update.slice(20), { fin: true });
  const updated = await updatedPromise;
  const player = updated.members.find((item) => item.nickname === "PLAYER01");
  assert.equal(player.roleLabel, "成员");
  assert.deepEqual(player.positions, ["member"]);

  const errorPromise = nextMessage(member, (message) => message.type === "presence:error");
  member.send("{malformed");
  assert.equal((await errorPromise).error, "消息不是有效 JSON");

  const invalidChannelError = nextMessage(member, (message) =>
    message.type === "presence:error" && message.error === "频道不存在");
  member.send(JSON.stringify({
    type: "presence:set-location", state: "in_channel", channelId: "missing",
  }));
  await invalidChannelError;
  assert.equal(fixture.presence.publicMembers("user:member-id")[0].channelId, "cs2");

  const unknownMessageError = nextMessage(member, (message) =>
    message.type === "presence:error" && message.error === "无效的在线状态消息");
  member.send(JSON.stringify({ type: "presence:unknown", state: "lobby" }));
  await unknownMessageError;

  for (let index = 0; index < 10; index += 1) {
    member.send(JSON.stringify({ type: "presence:set-location", state: "lobby", channelId: null }));
  }
  await nextMessage(member, (message) =>
    message.type === "presence:snapshot" &&
    message.members.find((item) => item.nickname === "PLAYER01")?.state === "lobby");
});

test("binary and oversized messages are closed by the ws transport", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.close);

  const binary = await connect(fixture.url, "member");
  const binaryClose = waitForClose(binary);
  binary.send(Buffer.from([1, 2, 3]));
  assert.equal((await binaryClose).code, 1003);

  const oversized = await connect(fixture.url, "member");
  const oversizedClose = waitForClose(oversized);
  oversized.send("x".repeat(4097));
  assert.equal((await oversizedClose).code, 1009);
});

test("normal close, terminate, heartbeat, and identity invalidation clean up Presence", async (t) => {
  let valid = true;
  const fixture = await createFixture({
    heartbeatMs: 30,
    authResolver: (req) => valid ? cookieIdentity(req) : null,
  });
  t.after(fixture.close);

  const normal = await connect(fixture.url, "admin");
  assert.equal(fixture.presence.publicMembers("user:admin-id").length, 1);
  const normalClose = waitForClose(normal);
  normal.close();
  await normalClose;
  assert.equal(fixture.presence.publicMembers("user:admin-id").length, 0);

  const abnormal = await connect(fixture.url, "member");
  abnormal.terminate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.presence.publicMembers("user:member-id").length, 0);

  const expiring = await connect(fixture.url, "guest");
  let pongCount = 0;
  expiring.on("ping", () => { pongCount += 1; });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(pongCount >= 1);
  valid = false;
  const closed = await waitForClose(expiring);
  assert.equal(closed.code, 4401);
  assert.equal(fixture.presence.publicMembers("guest:test-uuid").length, 0);
});

test("a client that does not answer ping is terminated by the heartbeat", async (t) => {
  const fixture = await createFixture({ heartbeatMs: 30 });
  t.after(fixture.close);
  const unresponsive = await connect(fixture.url, "member");
  unresponsive.pong = () => {};
  const closed = waitForClose(unresponsive);
  assert.equal((await closed).code, 1006);
  assert.equal(fixture.presence.publicMembers("user:member-id").length, 0);
});
