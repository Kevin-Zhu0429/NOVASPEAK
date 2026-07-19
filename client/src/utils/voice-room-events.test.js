import test from "node:test";
import assert from "node:assert/strict";
import { DisconnectReason } from "livekit-client";
import { getDisconnectOutcome, getForceLogoutPlan, getForceMovePlan, parseForceMoveChannelMessage, resolveMovedChannel } from "./voice-room-events.js";

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

// ---------- 自建 LiveKit fallback：voice_control / force_move_channel ----------

const forceMoveMessage = (patch = {}) => JSON.stringify({
  type: "voice_control",
  action: "force_move_channel",
  requestId: "req-1",
  targetChannelId: "apex",
  targetChannelName: "APEX",
  sourceChannelId: "cs2",
  reason: "admin_move",
  ...patch,
});

test("force_move_channel 控制消息解析出目标频道并触发切频道计划", () => {
  assert.deepEqual(parseForceMoveChannelMessage(forceMoveMessage()), {
    targetChannelId: "apex",
    targetChannelName: "APEX",
    sourceChannelId: "cs2",
  });
  const channels = [{ id: "cs2", name: "CS2" }, { id: "apex", name: "Apex 频道" }];
  // 频道名优先取本地频道列表，提示文案与 RoomEvent.Moved 路径一致
  assert.deepEqual(getForceMovePlan(forceMoveMessage(), channels), { channelId: "apex", notice: "你已被移动到“Apex 频道”" });
  // 本地列表未同步时退回消息内名称
  assert.deepEqual(getForceMovePlan(forceMoveMessage(), [{ id: "cs2", name: "CS2" }]), { channelId: "apex", notice: "你已被移动到“APEX”" });
});

test("非 force_move_channel 的 voice_control 与其他消息不误处理", () => {
  assert.equal(parseForceMoveChannelMessage(forceMoveMessage({ action: "server_mute" })), null);
  assert.equal(parseForceMoveChannelMessage(forceMoveMessage({ type: "announcement" })), null);
  assert.equal(parseForceMoveChannelMessage(forceMoveMessage({ targetChannelId: "" })), null);
  assert.equal(parseForceMoveChannelMessage(forceMoveMessage({ targetChannelId: 42 })), null);
  assert.equal(parseForceMoveChannelMessage(JSON.stringify({ type: "presence:snapshot", members: [] })), null);
  assert.equal(parseForceMoveChannelMessage("{broken"), null);
  assert.equal(parseForceMoveChannelMessage(null), null);
  assert.equal(getForceMovePlan(forceMoveMessage({ action: "other" }), [{ id: "apex", name: "Apex" }]), null);
});

test("force_logout 只解析服务端踢出控制消息", () => {
  assert.deepEqual(getForceLogoutPlan(JSON.stringify({ type: "voice_control", action: "force_logout" })), {
    notice: "你已被移出服务器，请重新登录",
  });
  assert.equal(getForceLogoutPlan(JSON.stringify({ type: "voice_control", action: "force_move_channel" })), null);
  assert.equal(getForceLogoutPlan("{broken"), null);
});
