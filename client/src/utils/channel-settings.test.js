import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChannelPatchPayload,
  calculateMoveDownSortPatches,
  calculateMoveUpSortPatches,
  canDeleteChannel,
  canMoveChannelDown,
  canMoveChannelUp,
  canToggleGuests,
  extractApiError,
  getAccessLevelLabel,
  getChannelFormInitialValues,
  parseMaxMembers,
} from "./channel-settings.js";

const channels = [
  { id: "a", sortOrder: 10 },
  { id: "b", sortOrder: 20 },
  { id: "c", sortOrder: 30 },
];

test("converts channel to form initial values", () => {
  assert.deepEqual(getChannelFormInitialValues({ name: " A ", description: "D", maxMembers: 5, accessLevel: "everyone", allowGuests: true }).maxMembersMode, "limited");
  assert.equal(getChannelFormInitialValues({ accessLevel: "admins", allowGuests: true }).allowGuests, false);
});

test("converts maxMembers null and integer values", () => {
  assert.deepEqual(parseMaxMembers("unlimited", ""), { maxMembers: null });
  assert.deepEqual(parseMaxMembers("limited", "12"), { maxMembers: 12 });
});

test("returns access level Chinese labels", () => {
  assert.equal(getAccessLevelLabel("everyone"), "所有正式成员及允许的访客");
  assert.equal(getAccessLevelLabel("members"), "仅正式战队成员");
  assert.equal(getAccessLevelLabel("admins"), "仅管理员");
});

test("guest switch is only enabled for everyone access", () => {
  assert.equal(canToggleGuests("everyone"), true);
  assert.equal(canToggleGuests("members"), false);
});

test("builds PATCH payload with trimmed name and guests disabled for members", () => {
  const result = buildChannelPatchPayload({ name: " 训练 ", description: " desc ", maxMembersMode: "unlimited", maxMembers: "", accessLevel: "members", allowGuests: true });
  assert.deepEqual(result.payload, { name: "训练", description: "desc", maxMembers: null, accessLevel: "members", allowGuests: false });
});

test("calculates move up sort patches", () => {
  assert.deepEqual(calculateMoveUpSortPatches(channels, 1).patches, [{ id: "b", sortOrder: 10 }, { id: "a", sortOrder: 20 }]);
});

test("calculates move down sort patches", () => {
  assert.deepEqual(calculateMoveDownSortPatches(channels, 1).patches, [{ id: "b", sortOrder: 30 }, { id: "c", sortOrder: 20 }]);
});

test("first item cannot move up", () => {
  assert.equal(canMoveChannelUp(channels, 0), false);
});

test("last item cannot move down", () => {
  assert.equal(canMoveChannelDown(channels, 2), false);
});

test("system channel cannot be deleted", () => {
  assert.equal(canDeleteChannel({ id: "lobby", isSystem: true }), false);
  assert.equal(canDeleteChannel({ id: "custom", isSystem: false }), true);
});

test("empty name validation fails", () => {
  assert.equal(buildChannelPatchPayload({ name: " ", description: "", maxMembersMode: "unlimited", accessLevel: "everyone" }).error, "频道名称必须为 1—40 个字符");
});

test("too long description validation fails", () => {
  assert.equal(buildChannelPatchPayload({ name: "A", description: "一".repeat(201), maxMembersMode: "unlimited", accessLevel: "everyone" }).error, "频道描述不能超过 200 个字符");
});

test("invalid max members validation fails", () => {
  assert.equal(parseMaxMembers("limited", "100").error, "人数上限必须是 1—99 的整数");
});

test("extracts Chinese API error", async () => {
  const response = new Response(JSON.stringify({ error: "频道内仍有成员，无法删除" }), { headers: { "content-type": "application/json" } });
  assert.equal(await extractApiError(response, "失败"), "频道内仍有成员，无法删除");
});
