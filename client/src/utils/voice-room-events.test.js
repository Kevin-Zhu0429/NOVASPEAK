import test from "node:test";
import assert from "node:assert/strict";
import { DisconnectReason } from "livekit-client";
import { getDisconnectOutcome, resolveMovedChannel } from "./voice-room-events.js";

test("undefined disconnect reason safely returns lobby", () => {
  assert.doesNotThrow(() => getDisconnectOutcome(undefined));
  assert.deepEqual(getDisconnectOutcome(undefined), { action: "lobby", message: "连接已断开", removed: false });
});

test("participant removed returns lobby with removed message", () => {
  assert.deepEqual(getDisconnectOutcome(DisconnectReason.PARTICIPANT_REMOVED), { action: "lobby", message: "你已被移出语音频道", removed: true });
});

test("moved room ignores late disconnect and resolves target channel", () => {
  assert.deepEqual(getDisconnectOutcome(DisconnectReason.CLIENT_INITIATED, { moved: true }), { action: "ignore" });
  assert.equal(resolveMovedChannel("beta", [{ id: "alpha" }, { id: "beta", name: "Beta" }])?.name, "Beta");
});
