import test from "node:test";
import assert from "node:assert/strict";
import {
  getPresenceDeviceText, getPresenceLocationText, getPresencePositionText,
  parsePresenceMessage, sortPresenceMembers,
} from "./presence-display.js";

test("parses valid snapshots and rejects malformed messages", () => {
  const member = { presenceId: "p", nickname: "Nova", state: "lobby" };
  assert.deepEqual(parsePresenceMessage(JSON.stringify({ type: "presence:snapshot", members: [member] })), [member]);
  assert.equal(parsePresenceMessage("{bad"), null);
});

test("sort is current user then channel, reconnecting and lobby", () => {
  const members = [
    { presenceId: "1", nickname: "B", state: "lobby" },
    { presenceId: "2", nickname: "A", state: "reconnecting" },
    { presenceId: "3", nickname: "C", state: "in_channel" },
    { presenceId: "4", nickname: "Me", state: "lobby", isCurrentUser: true },
  ];
  assert.deepEqual(sortPresenceMembers(members).map((item) => item.presenceId), ["4", "3", "2", "1"]);
});

test("formats location, positions, guest and devices", () => {
  assert.equal(getPresenceLocationText({ state: "reconnecting", channelName: "CS2" }), "正在重连 · CS2");
  assert.equal(getPresencePositionText({ positionNames: ["队长", "狙击手"] }), "队长 · 狙击手");
  assert.equal(getPresencePositionText({ isGuest: true }), "访客");
  assert.equal(getPresenceDeviceText({ deviceCount: 2 }), "2 个设备在线");
});
