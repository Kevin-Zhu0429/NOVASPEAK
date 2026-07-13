import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIC_CONSTRAINTS,
  MIC_CONSTRAINTS_STORAGE_KEY,
  MIC_CONSTRAINT_KEYS,
  applyMicConstraintsToRoom,
  getAudioCaptureDefaults,
  getMicrophoneRestartOptions,
  loadMicConstraints,
  normalizeMicConstraints,
  sameMicConstraints,
  saveMicConstraints,
  setMicConstraint,
} from "./microphone-constraints.js";

function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

function createFakeRoom({ track, activeDeviceId, state, options } = {}) {
  const calls = [];
  return {
    calls,
    state,
    options: options !== undefined ? options : { audioCaptureDefaults: { deviceId: "picked-mic" } },
    getActiveDevice: (kind) => {
      calls.push(["getActiveDevice", kind]);
      return activeDeviceId;
    },
    localParticipant: {
      setMicrophoneEnabled: () => {
        calls.push(["setMicrophoneEnabled"]);
        throw new Error("降噪开关不应触碰麦克风开关");
      },
      getTrackPublication: (source) => {
        calls.push(["getTrackPublication", source]);
        return track ? { track } : undefined;
      },
    },
  };
}

function createFakeTrack({ deviceId, getDeviceIdError, restartError, isMuted = false } = {}) {
  const calls = [];
  return {
    calls,
    isMuted,
    getDeviceId: async (normalize) => {
      calls.push(["getDeviceId", normalize]);
      if (getDeviceIdError) throw getDeviceIdError;
      return deviceId;
    },
    restartTrack: async (options) => {
      calls.push(["restartTrack", options]);
      if (restartError) throw restartError;
    },
    mute: async () => {
      calls.push(["mute"]);
      throw new Error("降噪开关不应调用 mute");
    },
    unmute: async () => {
      calls.push(["unmute"]);
      throw new Error("降噪开关不应调用 unmute");
    },
  };
}

test("默认值：回声消除开、噪声抑制开、自动增益关", () => {
  assert.deepEqual(DEFAULT_MIC_CONSTRAINTS, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  assert.deepEqual(normalizeMicConstraints(null), DEFAULT_MIC_CONSTRAINTS);
  assert.deepEqual(loadMicConstraints(createFakeStorage()), DEFAULT_MIC_CONSTRAINTS);
});

test("非 boolean 字段逐项回退默认值", () => {
  const normalized = normalizeMicConstraints({ echoCancellation: "yes", noiseSuppression: false, autoGainControl: 1 });
  assert.deepEqual(normalized, { echoCancellation: true, noiseSuppression: false, autoGainControl: false });
  assert.deepEqual(normalizeMicConstraints([true, true, true]), DEFAULT_MIC_CONSTRAINTS);
  assert.deepEqual(normalizeMicConstraints("abc"), DEFAULT_MIC_CONSTRAINTS);
});

test("normalize 忽略未知字段", () => {
  const normalized = normalizeMicConstraints({ autoGainControl: true, volume: 999, muted: true });
  assert.deepEqual(Object.keys(normalized).sort(), [...MIC_CONSTRAINT_KEYS].sort());
  assert.equal(normalized.autoGainControl, true);
});

test("localStorage JSON 损坏时不崩溃并回退默认值", () => {
  const broken = createFakeStorage({ [MIC_CONSTRAINTS_STORAGE_KEY]: "{broken json" });
  assert.deepEqual(loadMicConstraints(broken), DEFAULT_MIC_CONSTRAINTS);
  const arrayStorage = createFakeStorage({ [MIC_CONSTRAINTS_STORAGE_KEY]: "[1,2]" });
  assert.deepEqual(loadMicConstraints(arrayStorage), DEFAULT_MIC_CONSTRAINTS);
});

test("storage 访问抛错时安全回退", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  assert.deepEqual(loadMicConstraints(throwing), DEFAULT_MIC_CONSTRAINTS);
  assert.equal(saveMicConstraints({ autoGainControl: true }, throwing), false);
});

test("保存后可读取，且写入值已归一化", () => {
  const storage = createFakeStorage();
  assert.equal(saveMicConstraints({ echoCancellation: false, autoGainControl: "on" }, storage), true);
  assert.deepEqual(loadMicConstraints(storage), { echoCancellation: false, noiseSuppression: true, autoGainControl: false });
});

test("setMicConstraint 不修改原对象且忽略未知 key", () => {
  const before = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
  const after = setMicConstraint(before, "autoGainControl", true);
  assert.deepEqual(before, { echoCancellation: true, noiseSuppression: true, autoGainControl: false });
  assert.deepEqual(after, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  assert.deepEqual(setMicConstraint(before, "volume", true), before);
  assert.equal(setMicConstraint(before, "noiseSuppression", "yes").noiseSuppression, false);
});

test("sameMicConstraints 归一化后比较", () => {
  assert.equal(sameMicConstraints(null, DEFAULT_MIC_CONSTRAINTS), true);
  assert.equal(sameMicConstraints({ autoGainControl: "yes" }, { autoGainControl: false }), true);
  assert.equal(sameMicConstraints({ autoGainControl: true }, { autoGainControl: false }), false);
});

test("getAudioCaptureDefaults 只包含三个降噪约束", () => {
  const defaults = getAudioCaptureDefaults({ autoGainControl: true, deviceId: "x" });
  assert.deepEqual(defaults, { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
});

test("restart 参数带上有效 deviceId，无效 deviceId 时不带", () => {
  const withDevice = getMicrophoneRestartOptions({ noiseSuppression: false }, "mic-1");
  assert.deepEqual(withDevice, { echoCancellation: true, noiseSuppression: false, autoGainControl: false, deviceId: "mic-1" });
  assert.equal("deviceId" in getMicrophoneRestartOptions({}, ""), false);
  assert.equal("deviceId" in getMicrophoneRestartOptions({}, undefined), false);
  assert.equal("deviceId" in getMicrophoneRestartOptions({}, 42), false);
});

test("applyMicConstraintsToRoom：无房间 / 已断开时不做任何事", async () => {
  assert.deepEqual(await applyMicConstraintsToRoom(null, {}), { status: "no-room" });
  assert.deepEqual(await applyMicConstraintsToRoom({}, {}), { status: "no-room" });
  const disconnected = createFakeRoom({ state: "disconnected" });
  assert.deepEqual(await applyMicConstraintsToRoom(disconnected, {}), { status: "not-connected" });
  assert.deepEqual(disconnected.calls, []);
});

test("applyMicConstraintsToRoom：无麦克风轨道时只更新采集默认值并保留 deviceId", async () => {
  const room = createFakeRoom({});
  const result = await applyMicConstraintsToRoom(room, { autoGainControl: true });
  assert.deepEqual(result, { status: "no-track" });
  assert.deepEqual(room.options.audioCaptureDefaults, {
    deviceId: "picked-mic",
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});

test("applyMicConstraintsToRoom：room.options 缺失时不崩溃", async () => {
  const room = createFakeRoom({ options: null });
  assert.deepEqual(await applyMicConstraintsToRoom(room, {}), { status: "no-track" });
});

test("applyMicConstraintsToRoom：用当前轨道 deviceId 重启麦克风轨道", async () => {
  const track = createFakeTrack({ deviceId: "usb-mic" });
  const room = createFakeRoom({ track });
  const result = await applyMicConstraintsToRoom(room, { noiseSuppression: false });
  assert.deepEqual(result, { status: "restarted" });
  assert.deepEqual(track.calls, [
    ["getDeviceId", false],
    ["restartTrack", { echoCancellation: true, noiseSuppression: false, autoGainControl: false, deviceId: "usb-mic" }],
  ]);
});

test("applyMicConstraintsToRoom：getDeviceId 失败时回退 getActiveDevice", async () => {
  const track = createFakeTrack({ getDeviceIdError: new Error("gone") });
  const room = createFakeRoom({ track, activeDeviceId: "default" });
  const result = await applyMicConstraintsToRoom(room, {});
  assert.deepEqual(result, { status: "restarted" });
  const restartCall = track.calls.find(([name]) => name === "restartTrack");
  assert.equal(restartCall[1].deviceId, "default");
});

test("applyMicConstraintsToRoom：拿不到任何 deviceId 时不带 deviceId 重启", async () => {
  const track = createFakeTrack({ deviceId: undefined });
  const room = createFakeRoom({ track, activeDeviceId: undefined });
  const result = await applyMicConstraintsToRoom(room, {});
  assert.deepEqual(result, { status: "restarted" });
  const restartCall = track.calls.find(([name]) => name === "restartTrack");
  assert.equal("deviceId" in restartCall[1], false);
});

test("applyMicConstraintsToRoom：restartTrack 失败时返回 failed 而不抛出", async () => {
  const error = new Error("NotReadableError");
  const track = createFakeTrack({ deviceId: "usb-mic", restartError: error });
  const room = createFakeRoom({ track });
  const result = await applyMicConstraintsToRoom(room, {});
  assert.equal(result.status, "failed");
  assert.equal(result.error, error);
});

test("三态隔离：降噪应用只调用 restartTrack，不碰麦克风开关 / mute / unmute", async () => {
  const mutedTrack = createFakeTrack({ deviceId: "usb-mic", isMuted: true });
  const room = createFakeRoom({ track: mutedTrack });
  const result = await applyMicConstraintsToRoom(room, { autoGainControl: true });
  assert.deepEqual(result, { status: "restarted" });
  const callNames = mutedTrack.calls.map(([name]) => name);
  assert.deepEqual(callNames, ["getDeviceId", "restartTrack"]);
  assert.equal(room.calls.some(([name]) => name === "setMicrophoneEnabled"), false);
  assert.equal(mutedTrack.isMuted, true);
});
