import assert from "node:assert/strict";
import test from "node:test";
import {
  canMoveUserRole,
  canRemoveUserRole,
  getRoleLabel,
  getUserManagementCapabilities,
} from "./roles.js";

test("ordinary user has a stable public label", () => {
  assert.equal(getRoleLabel("user"), "普通语音用户");
});

test("member can move members, users and guests but never admins", () => {
  assert.equal(canMoveUserRole("member", "admin"), false);
  assert.equal(canMoveUserRole("member", "member"), true);
  assert.equal(canMoveUserRole("member", "user"), true);
  assert.equal(canMoveUserRole("member", "guest"), true);
});

test("ordinary user moves only users and guests and cannot remove users", () => {
  assert.equal(canMoveUserRole("user", "member"), false);
  assert.equal(canMoveUserRole("user", "user"), true);
  assert.equal(canMoveUserRole("user", "guest"), true);
  assert.equal(canRemoveUserRole("user", "guest"), false);
  assert.deepEqual(getUserManagementCapabilities("user", "guest"), {
    canMove: true,
    canRemove: false,
    canServerMute: false,
  });
});
