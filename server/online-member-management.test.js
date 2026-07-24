import test from "node:test";
import assert from "node:assert/strict";
import { createOnlineMemberManagementService } from "./online-member-management.js";

const channels = new Map([
  ["lobby", { id: "lobby", name: "大厅", access_level: "everyone", allow_guests: 1 }],
  ["members", { id: "members", name: "成员频道", access_level: "members", allow_guests: 0 }],
]);

function fixture(target = {}, serviceOptions = {}) {
  const calls = [];
  const resolved = {
    presenceId: "presence-target",
    userId: "target-user",
    role: "member",
    isGuest: false,
    nickname: "目标成员",
    state: "lobby",
    channelId: null,
    ...target,
  };
  const presenceService = {
    getManagementTarget: (id) => id === resolved.presenceId ? resolved : null,
    beginPresenceMemberMove: (...args) => { calls.push(["begin", ...args]); return true; },
    cancelPresenceMemberMove: (...args) => { calls.push(["cancel", ...args]); return true; },
    sendVoiceControlToPresenceMember: (...args) => { calls.push(["move", ...args]); return true; },
    disconnectPresenceMember: (...args) => { calls.push(["kick", ...args]); return true; },
  };
  const service = createOnlineMemberManagementService({
    presenceService,
    channelLookup: (id) => channels.get(id),
    revokeRegisteredSessions: (id) => calls.push(["revoke", id]),
    ...serviceOptions,
  });
  return { service, calls, resolved, presenceService };
}

test("Admin/Member 可以移动在线成员，Guest 被拒绝且前端只提交 presenceId", () => {
  const { service, calls } = fixture();
  assert.equal(service.move({ actor: { id: "guest:x", role: "guest" }, targetPresenceId: "presence-target", targetChannelId: "lobby" }).status, 403);
  const result = service.move({ actor: { id: "actor", role: "member" }, targetPresenceId: "presence-target", targetChannelId: "members" });
  assert.equal(result.success, true);
  assert.equal(calls[0][0], "begin");
  assert.equal(calls[1][0], "move");
  assert.equal(calls[1][1], "presence-target");
  assert.equal(calls[1][2].action, "force_move_channel");
});

test("不能操作自己、已离线成员、当前频道或无权限频道", () => {
  assert.equal(fixture().service.move({ actor: { id: "target-user", role: "admin" }, targetPresenceId: "presence-target", targetChannelId: "lobby" }).status, 400);
  assert.equal(fixture().service.move({ actor: { id: "actor", role: "admin" }, targetPresenceId: "missing", targetChannelId: "lobby" }).status, 404);
  assert.equal(fixture({ state: "in_channel", channelId: "lobby" }).service.move({ actor: { id: "actor", role: "admin" }, targetPresenceId: "presence-target", targetChannelId: "lobby" }).status, 400);
  assert.equal(fixture({ role: "guest", isGuest: true }).service.move({ actor: { id: "actor", role: "admin" }, targetPresenceId: "presence-target", targetChannelId: "members" }).status, 403);
});

test("踢出服务器会先通知目标并撤销正式成员会话；Member 不能踢 Admin", () => {
  const memberTarget = fixture();
  const result = memberTarget.service.kick({ actor: { id: "actor", role: "member" }, targetPresenceId: "presence-target" });
  assert.equal(result.success, true);
  assert.deepEqual(memberTarget.calls.map((call) => call[0]), ["kick", "revoke"]);
  assert.equal(memberTarget.calls[0][2].action, "force_logout");

  const adminTarget = fixture({ role: "admin" });
  assert.equal(adminTarget.service.kick({ actor: { id: "actor", role: "member" }, targetPresenceId: "presence-target" }).status, 403);
  assert.equal(adminTarget.service.kick({ actor: { id: "actor", role: "admin" }, targetPresenceId: "presence-target" }).success, true);
});

test("Guest 被踢时由控制消息清 Cookie，不尝试删除数据库 session", () => {
  const target = fixture({ userId: "guest:uuid", role: "guest", isGuest: true });
  assert.equal(target.service.kick({ actor: { id: "actor", role: "admin" }, targetPresenceId: "presence-target" }).success, true);
  assert.deepEqual(target.calls.map((call) => call[0]), ["kick"]);
});

test("踢人权限使用数据库中的最新角色，不信任 Presence 缓存角色", () => {
  const { service, calls } = fixture({ role: "member" }, {
    registeredUserLookup: (id) => ({ id, role: "admin" }),
  });
  const result = service.kick({ actor: { id: "actor", role: "member" }, targetPresenceId: "presence-target" });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 0);
});

test("普通用户只能移动普通用户和访客，不能踢人或移动战队成员", () => {
  const ordinaryTarget = fixture({ role: "user" });
  assert.equal(ordinaryTarget.service.move({
    actor: { id: "actor", role: "user" },
    targetPresenceId: "presence-target",
    targetChannelId: "lobby",
  }).success, true);
  assert.equal(ordinaryTarget.service.kick({
    actor: { id: "actor", role: "user" },
    targetPresenceId: "presence-target",
  }).status, 403);
  assert.equal(fixture({ role: "member" }).service.move({
    actor: { id: "actor", role: "user" },
    targetPresenceId: "presence-target",
    targetChannelId: "lobby",
  }).status, 403);
});
