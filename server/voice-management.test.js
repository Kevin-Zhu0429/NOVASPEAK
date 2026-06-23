import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceManagementService } from "./voice-management.js";

const admin = { id: "admin-id", role: "admin", displayName: "Admin" };
const member = { id: "member-id", role: "member", displayName: "Member", positions: ["captain"] };
const guest = { id: "guest:g", role: "guest", displayName: "Guest", isGuest: true };
const target = {
  identity: "target-id",
  name: "目标成员",
  metadata: JSON.stringify({ displayName: "目标成员", role: "admin" }),
  permission: { canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: [2, 3] },
  tracks: [{ sid: "mic-track", source: 2 }],
};

function makeService({ participants = [target] } = {}) {
  const calls = [];
  const presence = { events: [], setConnectionLocation(identity, source, next) { this.events.push(["set", identity, source, next]); return true; }, sendCommandToChannelConnection(identity, channel, command) { this.events.push(["cmd", identity, channel, command.command]); return true; } };
  const service = createVoiceManagementService({
    roomService: {
      async listParticipants(room) { calls.push(["list", room]); return participants; },
      async mutePublishedTrack(room, identity, trackSid, muted) { calls.push(["muteTrack", room, identity, trackSid, muted]); },
      async updateParticipant(room, identity, options) { calls.push(["update", room, identity, options]); },
      async removeParticipant(room, identity) { calls.push(["remove", room, identity]); },
      async moveParticipant(room, identity, destination) { calls.push(["move", room, identity, destination]); },
    },
    channelLookup(id) { return { cs2: { id: "cs2", name: "CS2" }, apex: { id: "apex", name: "Apex" } }[id] || null; },
    presenceService: presence,
    randomId: () => "request-id",
  });
  return { service, calls, presence };
}

test("voice management role permissions are based only on role", async () => {
  const { service } = makeService();
  assert.equal((await service.mute({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.unmute({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.remove({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 403);
  assert.equal((await service.move({ actor: guest, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" })).status, 403);
  assert.equal((await service.remove({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" })).success, true);
  assert.equal((await service.move({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" })).success, true);
});

test("voice management rejects missing auth, self operations and invalid parameters", async () => {
  const { service } = makeService({ participants: [] });
  assert.equal((await service.remove({ actor: null, sourceChannelId: "cs2", participantIdentity: "target-id" })).status, 401);
  assert.equal((await service.remove({ actor: admin, sourceChannelId: "missing", participantIdentity: "target-id" })).status, 404);
  assert.equal((await service.remove({ actor: admin, sourceChannelId: "cs2", participantIdentity: "admin-id" })).status, 400);
  assert.equal((await service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "cs2" })).status, 404);
  const present = makeService();
  assert.equal((await present.service.move({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "cs2" })).status, 400);
});

test("admin mute uses LiveKit track mute and participant permissions, then restores original permissions", async () => {
  const { service, calls } = makeService();
  const muted = await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(muted.serverMuted, true);
  assert.deepEqual(calls.find((call) => call[0] === "muteTrack"), ["muteTrack", "cs2", "target-id", "mic-track", true]);
  const update = calls.find((call) => call[0] === "update");
  assert.equal(update[3].permission.canPublishSources.includes(2), false);
  assert.equal((await service.mute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" })).idempotent, true);
  const unmuted = await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.equal(unmuted.serverMuted, false);
  const lastUpdate = calls.filter((call) => call[0] === "update").at(-1);
  assert.deepEqual(lastUpdate[3].permission, target.permission);
  assert.equal((await service.unmute({ actor: admin, sourceChannelId: "cs2", participantIdentity: "target-id" })).idempotent, true);
});

test("remove and move call real LiveKit wrapper methods and update only source channel presence", async () => {
  const { service, calls, presence } = makeService();
  await service.remove({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id" });
  assert.deepEqual(calls.find((call) => call[0] === "remove"), ["remove", "cs2", "target-id"]);
  assert.deepEqual(presence.events.find((event) => event[0] === "set").slice(0, 3), ["set", "target-id", "cs2"]);
  await service.move({ actor: member, sourceChannelId: "cs2", participantIdentity: "target-id", targetChannelId: "apex" });
  assert.deepEqual(calls.find((call) => call[0] === "move"), ["move", "cs2", "target-id", "apex"]);
});
