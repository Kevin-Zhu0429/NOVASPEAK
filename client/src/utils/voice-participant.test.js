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


test("local server mute notifications are edge-triggered", async () => {
  const { getLocalServerMuteTransition } = await import("./voice-participant.js");
  assert.deepEqual(getLocalServerMuteTransition(undefined, false, false), { current: false, message: "" });
  assert.deepEqual(getLocalServerMuteTransition(null, false, false), { current: false, message: "" });
  assert.deepEqual(getLocalServerMuteTransition(false, false, true), { current: false, message: "" });
  assert.deepEqual(getLocalServerMuteTransition(true, false, true), { current: false, message: "服务器静音已解除，请自行开启麦克风" });
  assert.deepEqual(getLocalServerMuteTransition(false, true, true), { current: true, message: "你已被服务器静音" });
});

// ---------- 3B 修复：解除服务器静音后自动恢复麦克风 ----------

test("mic 原本开启，被 serverMuted=true 后记录 true", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const plan = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: false, currentServerMuted: true, microphoneEnabled: true, rememberedMicEnabled: null });
  assert.deepEqual(plan, { rememberedMicEnabled: true, shouldRestoreMicrophone: false });
});

test("serverMuted true -> false 且记录为 true 时自动恢复 mic，并清空记录", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const plan = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: true, currentServerMuted: false, microphoneEnabled: false, rememberedMicEnabled: true });
  assert.deepEqual(plan, { rememberedMicEnabled: null, shouldRestoreMicrophone: true });
});

test("mic 原本关闭，被 serverMuted=true 后记录 false，解除后不自动开启", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const muted = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: false, currentServerMuted: true, microphoneEnabled: false, rememberedMicEnabled: null });
  assert.deepEqual(muted, { rememberedMicEnabled: false, shouldRestoreMicrophone: false });
  const unmuted = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: true, currentServerMuted: false, microphoneEnabled: false, rememberedMicEnabled: muted.rememberedMicEnabled });
  assert.deepEqual(unmuted, { rememberedMicEnabled: null, shouldRestoreMicrophone: false });
});

test("非本地用户的 serverMuted 变化不触发本地 mic 恢复", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const plan = getServerMuteMicrophonePlan({ isLocal: false, previousServerMuted: true, currentServerMuted: false, microphoneEnabled: true, rememberedMicEnabled: true });
  assert.deepEqual(plan, { rememberedMicEnabled: null, shouldRestoreMicrophone: false });
});

test("自动恢复失败时有可展示的中文错误提示", async () => {
  const { MICROPHONE_RESTORE_FAILED_MESSAGE, MICROPHONE_RESTORED_MESSAGE, MICROPHONE_RESTORING_MESSAGE } = await import("./voice-participant.js");
  assert.equal(MICROPHONE_RESTORE_FAILED_MESSAGE, "服务器静音已解除，但麦克风恢复失败，请手动开启。");
  assert.ok(MICROPHONE_RESTORED_MESSAGE.length > 0);
  assert.ok(MICROPHONE_RESTORING_MESSAGE.length > 0);
});

test("serverMuted 保持 false 的重复 metadata 不重复开启麦克风", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const plan = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: false, currentServerMuted: false, microphoneEnabled: false, rememberedMicEnabled: null });
  assert.deepEqual(plan, { rememberedMicEnabled: null, shouldRestoreMicrophone: false });
});

test("禁音持续期间保留记录，Deafen 不参与恢复判断", async () => {
  const { getServerMuteMicrophonePlan } = await import("./voice-participant.js");
  const holding = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: true, currentServerMuted: true, microphoneEnabled: false, rememberedMicEnabled: true });
  assert.deepEqual(holding, { rememberedMicEnabled: true, shouldRestoreMicrophone: false });
  // 纯函数签名不包含 deafen：传入多余的 deafened 字段不改变判断
  const withDeafenFlag = getServerMuteMicrophonePlan({ isLocal: true, previousServerMuted: true, currentServerMuted: false, microphoneEnabled: false, rememberedMicEnabled: true, deafened: true });
  assert.deepEqual(withDeafenFlag, { rememberedMicEnabled: null, shouldRestoreMicrophone: true });
});
