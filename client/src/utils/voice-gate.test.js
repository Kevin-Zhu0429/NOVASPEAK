import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOICE_GATE_SETTINGS,
  MAX_VOICE_GATE_THRESHOLD_DB,
  MIN_VOICE_GATE_THRESHOLD_DB,
  advanceVoiceGateState,
  calculateRms,
  clampVoiceGateThreshold,
  createVoiceGateProcessor,
  loadVoiceGateSettings,
  normalizeVoiceGateSettings,
  rmsToDecibels,
  saveVoiceGateSettings,
} from "./voice-gate.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("Voice Gate 默认关闭，阈值为 -45dB", () => {
  assert.deepEqual(normalizeVoiceGateSettings(null), DEFAULT_VOICE_GATE_SETTINGS);
});

test("Voice Gate 阈值限制在 -65dB 到 -20dB", () => {
  assert.equal(clampVoiceGateThreshold(-100), MIN_VOICE_GATE_THRESHOLD_DB);
  assert.equal(clampVoiceGateThreshold(5), MAX_VOICE_GATE_THRESHOLD_DB);
  assert.equal(clampVoiceGateThreshold(-42.4), -42);
  assert.equal(clampVoiceGateThreshold("bad"), -45);
});

test("Voice Gate 设置只接受严格 boolean 并可持久化", () => {
  const storage = createStorage();
  assert.equal(saveVoiceGateSettings({ enabled: true, thresholdDb: -38 }, storage), true);
  assert.deepEqual(loadVoiceGateSettings(storage), { enabled: true, thresholdDb: -38 });
  assert.equal(normalizeVoiceGateSettings({ enabled: "yes" }).enabled, false);
});

test("损坏的 Voice Gate localStorage 回退默认值", () => {
  const storage = { getItem: () => "{" };
  assert.deepEqual(loadVoiceGateSettings(storage), DEFAULT_VOICE_GATE_SETTINGS);
});

test("RMS 与 dB 换算稳定", () => {
  assert.equal(calculateRms(new Float32Array([1, -1, 1, -1])), 1);
  assert.equal(rmsToDecibels(1), 0);
  assert.ok(Math.abs(rmsToDecibels(0.1) + 20) < 0.0001);
  assert.equal(rmsToDecibels(0), -100);
});

test("高于阈值立即开门", () => {
  assert.deepEqual(
    advanceVoiceGateState({ open: false, levelDb: -39, thresholdDb: -40, nowMs: 100 }),
    { open: true, lastVoiceAtMs: 100 }
  );
});

test("6dB 滞回避免阈值附近抖动", () => {
  const next = advanceVoiceGateState({
    open: true,
    levelDb: -44,
    thresholdDb: -40,
    lastVoiceAtMs: 50,
    nowMs: 100,
  });
  assert.deepEqual(next, { open: true, lastVoiceAtMs: 100 });
});

test("低于关闭阈值仍保持 180ms，之后关门", () => {
  const held = advanceVoiceGateState({
    open: true,
    levelDb: -60,
    thresholdDb: -40,
    lastVoiceAtMs: 100,
    nowMs: 250,
  });
  assert.equal(held.open, true);
  const closed = advanceVoiceGateState({
    open: true,
    levelDb: -60,
    thresholdDb: -40,
    lastVoiceAtMs: 100,
    nowMs: 281,
  });
  assert.equal(closed.open, false);
});

test("Voice Gate processor 生成处理轨道、按电平开门并完整清理", async () => {
  const originalMediaStream = globalThis.MediaStream;
  const outputTrack = { stopped: 0, stop() { this.stopped += 1; } };
  const inputTrack = { id: "input-track" };
  const stateChanges = [];
  const gainEvents = [];
  let timerCallback = null;
  let clearedTimer = null;
  let nowMs = 100;

  function node(extra = {}) {
    return {
      connected: [],
      disconnected: 0,
      connect(target) { this.connected.push(target); return target; },
      disconnect() { this.disconnected += 1; },
      ...extra,
    };
  }

  const analyser = node({
    fftSize: 1024,
    smoothingTimeConstant: 0,
    level: 0,
    getFloatTimeDomainData(samples) { samples.fill(this.level); },
  });
  const gain = node({
    gain: {
      value: 1,
      cancelScheduledValues() {},
      setTargetAtTime(value, time, constant) {
        gainEvents.push({ value, time, constant });
        this.value = value;
      },
    },
  });
  const context = {
    currentTime: 1,
    createMediaStreamSource: () => node(),
    createAnalyser: () => analyser,
    createDelay: () => node({ delayTime: { value: 0 } }),
    createGain: () => gain,
    createMediaStreamDestination: () => node({
      stream: { getAudioTracks: () => [outputTrack] },
    }),
  };

  globalThis.MediaStream = class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks; }
  };

  try {
    const processor = createVoiceGateProcessor({
      settings: { enabled: true, thresholdDb: -45 },
      onGateStateChange: (open) => stateChanges.push(open),
      now: () => nowMs,
      setTimer: (callback) => { timerCallback = callback; return 42; },
      clearTimer: (value) => { clearedTimer = value; },
    });

    await processor.init({ track: inputTrack, audioContext: context });
    assert.equal(processor.processedTrack, outputTrack);
    assert.equal(gain.gain.value, 0);
    assert.equal(typeof timerCallback, "function");

    analyser.level = 0.1; // -20dB，高于 -45dB 阈值
    timerCallback();
    assert.equal(gainEvents.at(-1).value, 1);
    assert.equal(stateChanges.at(-1), true);

    analyser.level = 0;
    nowMs = 350;
    timerCallback();
    assert.equal(gainEvents.at(-1).value, 0);
    assert.equal(stateChanges.at(-1), false);

    await processor.destroy();
    assert.equal(clearedTimer, 42);
    assert.equal(outputTrack.stopped, 1);
    assert.equal(processor.processedTrack, undefined);
  } finally {
    if (originalMediaStream === undefined) delete globalThis.MediaStream;
    else globalThis.MediaStream = originalMediaStream;
  }
});
