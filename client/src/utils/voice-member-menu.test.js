import test from "node:test";
import assert from "node:assert/strict";
import { getParticipantMenuActions, getParticipantStatusLabels } from "./voice-member-menu.js";
const item = { id: "u2", isLocal: false, serverMuted: false };
const currentChannel = { id: "a" };
const channels = [{ id: "a", name: "A" }, { id: "b", name: "B" }];

test("admin context menu contains local and management actions", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "admin" }, currentChannel, channels }), ["profile", "local-mute", "mute", "move", "move:b", "remove"]);
});

test("member context menu contains local actions, move and remove", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "member" }, currentChannel, channels }), ["profile", "local-mute", "move", "move:b", "remove"]);
});

test("guest context menu only contains local features", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "guest" }, currentChannel, channels }), ["profile", "local-mute"]);
});

test("own card excludes local mute and volume actions", () => {
  assert.deepEqual(getParticipantMenuActions({ item: { ...item, isLocal: true }, currentUser: { role: "admin" }, currentChannel, channels }), ["profile"]);
});

test("server mute and local mute labels can coexist", () => {
  assert.deepEqual(getParticipantStatusLabels({ serverMuted: true, localMuted: true }), { serverMuted: "已被服务器静音", localMuted: "已本地静音" });
});
