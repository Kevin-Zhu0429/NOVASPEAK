import test from "node:test";
import assert from "node:assert/strict";
import { Track } from "livekit-client";
import { isParticipantServerMuted, participantView } from "./voice-participant.js";

test("server mute defaults to false without explicit metadata", () => {
  assert.equal(isParticipantServerMuted(undefined), false);
  assert.equal(isParticipantServerMuted({ metadata: "" }), false);
  assert.equal(isParticipantServerMuted({ metadata: "not-json" }), false);
  assert.equal(isParticipantServerMuted({ metadata: "{}", permissions: undefined }), false);
  assert.equal(isParticipantServerMuted({ metadata: "{}", permissions: { canPublishSources: undefined } }), false);
});

test("server mute only follows explicit metadata boolean", () => {
  assert.equal(isParticipantServerMuted({ metadata: JSON.stringify({ serverMuted: true }) }), true);
  assert.equal(isParticipantServerMuted({ metadata: JSON.stringify({ serverMuted: false }) }), false);
});

test("local microphone mute is not server mute", () => {
  const participant = {
    identity: "u1",
    metadata: JSON.stringify({ displayName: "U1", serverMuted: false }),
    getTrackPublication(source) {
      assert.equal(source, Track.Source.Microphone);
      return { isMuted: true };
    },
  };
  const view = participantView(participant);
  assert.equal(view.microphoneEnabled, false);
  assert.equal(view.serverMuted, false);
});
