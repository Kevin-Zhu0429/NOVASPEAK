import test from "node:test";
import assert from "node:assert/strict";
import { createPresenceService } from "./presence.js";

function fakeConnection() { return { readyState: 1, bufferedAmount: 0, send() {}, on() {}, ping() {}, close() {}, terminate() {} }; }
const user = { id: "u1", displayName: "U1", role: "member", isGuest: false };

test("hasUsersInChannel only counts in_channel exact non-lobby matches", () => {
  const presence = createPresenceService({ autoHeartbeat: false, channelLookup: (id) => ({ id, name: id }) });
  const c1 = fakeConnection(); presence.addConnection(c1, {}, user);
  assert.equal(presence.hasUsersInChannel("c1"), false);
  const principal = presence.principals.get("user:u1");
  const state = principal.connections.get(c1);
  state.state = "reconnecting"; state.channelId = "c1";
  assert.equal(presence.hasUsersInChannel("c1"), false);
  state.state = "in_channel";
  assert.equal(presence.hasUsersInChannel("c1"), true);
  assert.equal(presence.hasUsersInChannel("c2"), false);
  assert.equal(presence.hasUsersInChannel("lobby"), false);
  presence.close();
});
