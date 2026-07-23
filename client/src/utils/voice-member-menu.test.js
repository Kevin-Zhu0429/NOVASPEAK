import test from "node:test";
import assert from "node:assert/strict";
import { getMemberContextMenuModel, getMemberStatusBadges, getParticipantMenuActions } from "./voice-member-menu.js";

const item = { id: "u2", isLocal: false, serverMuted: false, role: "member" };
const channels = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
const currentChannel = channels[0];

test("admin menu contains all management options", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "admin" }, currentChannel, channels }), ["mute", "move", "move:b", "remove"]);
});

test("member menu contains move and remove only", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "member" }, currentChannel, channels }), ["move", "move:b", "remove"]);
});

test("guest has no management menu", () => {
  assert.deepEqual(getParticipantMenuActions({ item, currentUser: { role: "guest" }, currentChannel, channels }), []);
});

test("ordinary user can move users and guests but not members or remove anyone", () => {
  const ordinary = { role: "user" };
  assert.deepEqual(getParticipantMenuActions({
    item: { ...item, role: "user" },
    currentUser: ordinary,
    currentChannel,
    channels,
  }), ["move", "move:b"]);
  assert.deepEqual(getParticipantMenuActions({
    item: { ...item, role: "guest" },
    currentUser: ordinary,
    currentChannel,
    channels,
  }), ["move", "move:b"]);
  assert.deepEqual(getParticipantMenuActions({
    item,
    currentUser: ordinary,
    currentChannel,
    channels,
  }), []);
});

test("音乐机器人只保留本地听音控制，不显示移动或移出操作", () => {
  const bot = { id: "music-bot:a", isLocal: false, isMusicBot: true };
  const model = getMemberContextMenuModel({
    item: bot,
    currentUser: { role: "admin" },
    currentChannel,
    channels,
    localPref: { volume: 50, muted: false },
  });
  assert.equal(model.showLocalControls, true);
  assert.equal(model.showVolumeSlider, true);
  assert.deepEqual(model.managementActions, []);
});

test("admin 右键其他成员包含本地功能和管理功能", () => {
  const model = getMemberContextMenuModel({ item, currentUser: { role: "admin" }, currentChannel, channels, localPref: { volume: 100, muted: false } });
  assert.equal(model.showProfile, true);
  assert.equal(model.showLocalControls, true);
  assert.equal(model.showVolumeSlider, true);
  assert.equal(model.localMuteAction, "local-mute");
  assert.deepEqual(model.managementActions, ["mute", "move", "move:b", "remove"]);
});

test("member 右键其他成员包含本地功能、移动、移出", () => {
  const model = getMemberContextMenuModel({ item, currentUser: { role: "member" }, currentChannel, channels, localPref: { volume: 100, muted: true } });
  assert.equal(model.showLocalControls, true);
  assert.equal(model.localMuteAction, "local-unmute");
  assert.deepEqual(model.managementActions, ["move", "move:b", "remove"]);
});

test("guest 右键其他成员只包含本地功能", () => {
  const model = getMemberContextMenuModel({ item, currentUser: { role: "guest" }, currentChannel, channels, localPref: { volume: 100, muted: false } });
  assert.equal(model.showProfile, true);
  assert.equal(model.showLocalControls, true);
  assert.equal(model.showVolumeSlider, true);
  assert.deepEqual(model.managementActions, []);
});

test("自己的卡片不显示本地静音和音量，也没有管理操作", () => {
  const self = { id: "u1", isLocal: true, serverMuted: false };
  const model = getMemberContextMenuModel({ item: self, currentUser: { role: "admin" }, currentChannel, channels, localPref: { volume: 100, muted: false } });
  assert.equal(model.showProfile, true);
  assert.equal(model.showLocalControls, false);
  assert.equal(model.showVolumeSlider, false);
  assert.equal(model.localMuteAction, "");
  assert.deepEqual(model.managementActions, []);
});

test("服务器静音和本地静音标签可以同时存在且互不覆盖", () => {
  assert.deepEqual(getMemberStatusBadges({ serverMuted: true, localMuted: true }), [
    { type: "server-muted", label: "已被服务器静音" },
    { type: "local-muted", label: "已本地静音" },
  ]);
  assert.deepEqual(getMemberStatusBadges({ serverMuted: true, localMuted: false }), [{ type: "server-muted", label: "已被服务器静音" }]);
  assert.deepEqual(getMemberStatusBadges({ serverMuted: false, localMuted: true }), [{ type: "local-muted", label: "已本地静音" }]);
  assert.deepEqual(getMemberStatusBadges({}), []);
});
