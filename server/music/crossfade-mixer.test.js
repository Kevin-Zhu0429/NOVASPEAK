import test from "node:test";
import assert from "node:assert/strict";
import {
  INT16_MAX,
  INT16_MIN,
  PCM_FRAME_MS,
  crossfadeProgress,
  equalPowerGains,
  mixFrames,
  scaleFrame,
} from "./crossfade-mixer.js";
import { PCM_FRAME_VALUES } from "./ffmpeg-decoder.js";

function frameOf(value, length = PCM_FRAME_VALUES) {
  return new Int16Array(length).fill(value);
}

// ---------- 等功率曲线 ----------

test("等功率曲线起点：oldGain=1，newGain=0", () => {
  const gains = equalPowerGains(0);
  assert.equal(gains.oldGain, 1);
  assert.equal(gains.newGain, 0);
});

test("等功率曲线中点：两个增益约为 √0.5", () => {
  const gains = equalPowerGains(0.5);
  assert.ok(Math.abs(gains.oldGain - Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(gains.newGain - Math.SQRT1_2) < 1e-9);
});

test("等功率曲线终点：oldGain=0，newGain=1", () => {
  const gains = equalPowerGains(1);
  assert.ok(Math.abs(gains.oldGain) < 1e-12);
  assert.equal(gains.newGain, 1);
});

test("progress 超界与非法值被安全夹取", () => {
  assert.equal(equalPowerGains(-3).oldGain, 1);
  assert.equal(equalPowerGains(7).newGain, 1);
  assert.equal(equalPowerGains(Number.NaN).oldGain, 1);
});

test("曲线单调变化：oldGain 递减、newGain 递增", () => {
  let previous = equalPowerGains(0);
  for (let step = 1; step <= 100; step += 1) {
    const current = equalPowerGains(step / 100);
    assert.ok(current.oldGain <= previous.oldGain + 1e-12);
    assert.ok(current.newGain >= previous.newGain - 1e-12);
    previous = current;
  }
});

test("总功率在容差内稳定：oldGain² + newGain² ≈ 1", () => {
  for (let step = 0; step <= 100; step += 1) {
    const { oldGain, newGain } = equalPowerGains(step / 100);
    const power = oldGain * oldGain + newGain * newGain;
    assert.ok(Math.abs(power - 1) < 1e-9, `progress=${step / 100} 功率漂移`);
  }
});

test("crossfadeProgress：600 帧生产淡化覆盖完整 0→1 闭区间", () => {
  assert.equal(crossfadeProgress(0, 600), 0);
  assert.equal(crossfadeProgress(599, 600), 1);
  const first = equalPowerGains(crossfadeProgress(0, 600));
  assert.equal(first.oldGain, 1); // 首个混音帧：old=1
  assert.equal(first.newGain, 0); //             new=0
  const last = equalPowerGains(crossfadeProgress(599, 600));
  assert.ok(Math.abs(last.oldGain) < 1e-12); // 末个混音帧：old=0
  assert.equal(last.newGain, 1); //              new=1
  let previous = -1;
  for (let frame = 0; frame < 600; frame += 1) {
    const progress = crossfadeProgress(frame, 600);
    assert.ok(progress >= previous); // 单调不减
    previous = progress;
  }
});

test("crossfadeProgress：短淡化端点与退化输入", () => {
  assert.equal(crossfadeProgress(0, 10), 0);
  assert.equal(crossfadeProgress(9, 10), 1);
  assert.equal(crossfadeProgress(0, 1), 1); // 单帧淡化直接取终点
  assert.equal(crossfadeProgress(5, 1), 1);
  assert.equal(crossfadeProgress(-3, 10), 0); // 非法帧序夹取到起点
  assert.equal(crossfadeProgress(99, 10), 1); // 超界夹取到终点
});

// ---------- 混音 ----------

test("两路静音混出静音", () => {
  const mixed = mixFrames(frameOf(0), frameOf(0), 0.6, 0.8);
  assert.ok(mixed.every((sample) => sample === 0));
});

test("单路有声：另一路静音时只按增益缩放", () => {
  const mixed = mixFrames(frameOf(1000), frameOf(0), 0.5, 1);
  assert.ok(mixed.every((sample) => sample === 500));
  const mixedNew = mixFrames(frameOf(0), frameOf(-2000), 1, 0.25);
  assert.ok(mixedNew.every((sample) => sample === -500));
});

test("正负采样值混合并四舍五入", () => {
  const mixed = mixFrames(frameOf(1001), frameOf(-500), 0.5, 1);
  // 1001×0.5 − 500 = 0.5 → round → 1（远离零方向即可，且不会截断为 0.5）
  assert.ok(mixed.every((sample) => sample === Math.round(1001 * 0.5 - 500)));
});

test("Int16 正向削波：不发生 wrap-around", () => {
  const mixed = mixFrames(frameOf(INT16_MAX), frameOf(INT16_MAX), 1, 1);
  assert.ok(mixed.every((sample) => sample === INT16_MAX));
});

test("Int16 负向削波：不发生 wrap-around", () => {
  const mixed = mixFrames(frameOf(INT16_MIN), frameOf(INT16_MIN), 1, 1);
  assert.ok(mixed.every((sample) => sample === INT16_MIN));
});

test("固定帧长度：输出与输入等长，长度不一致直接抛错", () => {
  const mixed = mixFrames(frameOf(3), frameOf(4), 0.5, 0.5);
  assert.equal(mixed.length, PCM_FRAME_VALUES);
  assert.throws(
    () => mixFrames(frameOf(3), frameOf(4, PCM_FRAME_VALUES - 2), 1, 0),
    RangeError
  );
});

test("不修改输入帧", () => {
  const oldFrame = frameOf(1234);
  const newFrame = frameOf(-4321);
  mixFrames(oldFrame, newFrame, 0.3, 0.7);
  assert.ok(oldFrame.every((sample) => sample === 1234));
  assert.ok(newFrame.every((sample) => sample === -4321));
  scaleFrame(oldFrame, 0.1);
  assert.ok(oldFrame.every((sample) => sample === 1234));
});

test("scaleFrame 同样四舍五入并削波", () => {
  assert.ok(scaleFrame(frameOf(999), 0.5).every((sample) => sample === 500));
  assert.ok(
    scaleFrame(frameOf(INT16_MAX), 4).every((sample) => sample === INT16_MAX)
  );
  assert.ok(
    scaleFrame(frameOf(INT16_MIN), 4).every((sample) => sample === INT16_MIN)
  );
});

test("帧参数常量与解码器一致：10ms/帧", () => {
  assert.equal(PCM_FRAME_MS, 10);
  assert.equal(PCM_FRAME_VALUES, 960);
});
