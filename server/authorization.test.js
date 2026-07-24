import assert from "node:assert/strict";
import test from "node:test";
import {
  canClearMusicQueue,
  canControlMusic,
  canManageChannels,
  canMoveRole,
  canRemoveRole,
  canServerMute,
  getRoleLabel,
  isFormalRole,
} from "./authorization.js";

test("formal roles and labels include ordinary users but never guests", () => {
  assert.equal(isFormalRole("admin"), true);
  assert.equal(isFormalRole("member"), true);
  assert.equal(isFormalRole("user"), true);
  assert.equal(isFormalRole("guest"), false);
  assert.equal(getRoleLabel("user"), "普通语音用户");
});

test("channel and music capabilities match the requested matrix", () => {
  assert.equal(canManageChannels("admin"), true);
  assert.equal(canManageChannels("member"), true);
  assert.equal(canManageChannels("user"), false);
  assert.equal(canControlMusic("user"), true);
  assert.equal(canClearMusicQueue("user"), false);
  assert.equal(canServerMute("member"), false);
  assert.equal(canServerMute("admin"), true);
});

test("member can move peers, users and guests but not administrators", () => {
  assert.equal(canMoveRole("member", "admin"), false);
  assert.equal(canMoveRole("member", "member"), true);
  assert.equal(canMoveRole("member", "user"), true);
  assert.equal(canMoveRole("member", "guest"), true);
});

test("ordinary users move only users and guests and cannot remove anyone", () => {
  assert.equal(canMoveRole("user", "admin"), false);
  assert.equal(canMoveRole("user", "member"), false);
  assert.equal(canMoveRole("user", "user"), true);
  assert.equal(canMoveRole("user", "guest"), true);
  assert.equal(canRemoveRole("user", "guest"), false);
});

test("member removal follows the same target boundary without admin access", () => {
  assert.equal(canRemoveRole("member", "admin"), false);
  assert.equal(canRemoveRole("member", "member"), true);
  assert.equal(canRemoveRole("member", "user"), true);
  assert.equal(canRemoveRole("member", "guest"), true);
});
