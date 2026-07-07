import test from "node:test";
import assert from "node:assert/strict";
import { getParticipantMenuActions } from "./voice-member-menu.js";

const item = { id: "u2", isLocal: false, serverMuted: false };
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
