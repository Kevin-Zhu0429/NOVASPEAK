import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANNELS,
  DEFAULT_DURATION_SECONDS,
  FRAME_MS,
  SAMPLE_RATE,
  SAMPLES_PER_FRAME,
  createTestTone,
  parseDurationSeconds,
} from "./test-tone.js";

test("音频格式常量：48000Hz 单声道 10ms 帧 480 采样", () => {
  assert.equal(SAMPLE_RATE, 48000);
  assert.equal(CHANNELS, 1);
  assert.equal(FRAME_MS, 10);
  assert.equal(SAMPLES_PER_FRAME, 480);
});

test("帧类型为 Int16Array 且长度为 480", () => {
  const tone = createTestTone({ durationSeconds: 1 });
  const frame = tone.frameAt(0);
  assert.ok(frame instanceof Int16Array);
  assert.equal(frame.length, 480);
  assert.equal(tone.totalFrames, 100);
  assert.equal(tone.sampleRate, 48000);
  assert.equal(tone.channels, 1);
});

test("采样值不超出 Int16 范围且音量保持低水平", () => {
  const tone = createTestTone({ durationSeconds: 2 });
  let peak = 0;
  for (let index = 0; index < tone.totalFrames; index += 1) {
    const frame = tone.frameAt(index);
    for (const sample of frame) {
      assert.ok(sample >= -32768 && sample <= 32767);
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  // 音量上限约 10% 满刻度（约 -20 dBFS），且确实有声音
  assert.ok(peak > 0, "测试音不能是纯静音");
  assert.ok(peak <= 0.1 * 32767, `峰值 ${peak} 超出低音量上限`);
});

test("连续帧之间相位连续（无爆音跳变）", () => {
  const tone = createTestTone({ durationSeconds: 1 });
  // 440Hz/48kHz 正弦波相邻采样最大差约 amp*32767*2π*440/48000 ≈ 151
  const maxAdjacentDelta = 200;
  for (let index = 1; index < tone.totalFrames; index += 1) {
    const previous = tone.frameAt(index - 1);
    const current = tone.frameAt(index);
    const delta = Math.abs(current[0] - previous[previous.length - 1]);
    assert.ok(
      delta <= maxAdjacentDelta,
      `帧 ${index - 1}→${index} 边界跳变 ${delta}`
    );
  }
});

test("首尾带淡入淡出，避免爆音", () => {
  const tone = createTestTone({ durationSeconds: 1 });
  const firstFrame = tone.frameAt(0);
  const lastFrame = tone.frameAt(tone.totalFrames - 1);
  assert.equal(firstFrame[0], 0);
  assert.ok(Math.abs(firstFrame[1]) < 50);
  assert.ok(Math.abs(lastFrame[lastFrame.length - 1]) < 50);
});

test("duration 参数校验：默认 5 秒，限制 1～30 整数", () => {
  assert.deepEqual(parseDurationSeconds(undefined), {
    ok: true,
    seconds: DEFAULT_DURATION_SECONDS,
  });
  assert.deepEqual(parseDurationSeconds(""), { ok: true, seconds: 5 });
  assert.deepEqual(parseDurationSeconds("1"), { ok: true, seconds: 1 });
  assert.deepEqual(parseDurationSeconds("30"), { ok: true, seconds: 30 });
  assert.deepEqual(parseDurationSeconds(7), { ok: true, seconds: 7 });

  for (const bad of ["0", "31", "-3", "abc", "2.5", "5s", NaN, Infinity]) {
    const result = parseDurationSeconds(bad);
    assert.equal(result.ok, false, `应拒绝 duration=${bad}`);
    assert.match(result.error, /1～30/);
  }
});

test("createTestTone 拒绝越界 duration 和过大幅度", () => {
  assert.throws(() => createTestTone({ durationSeconds: 0 }), RangeError);
  assert.throws(() => createTestTone({ durationSeconds: 31 }), RangeError);
  assert.throws(
    () => createTestTone({ durationSeconds: 5, amplitude: 0.9 }),
    RangeError
  );
  assert.throws(() => {
    const tone = createTestTone({ durationSeconds: 1 });
    tone.frameAt(100);
  }, RangeError);
});
