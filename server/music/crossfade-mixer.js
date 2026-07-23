// DJ 等功率交叉淡化混音（纯函数，无 IO、无状态）。
//
// 输入输出都是解码器产出的标准 PCM 帧：48kHz / 双声道 / s16le / 10ms
// （每帧 960 个 Int16 采样值 = 1920 字节）。混音只做逐采样加权求和：
//
//   mixed = oldSample × oldGain + newSample × newGain
//
// 增益使用等功率曲线（cos/sin），过渡全程 oldGain² + newGain² ≡ 1，
// 总响度保持平稳，避免固定 50%+50% 造成的响度凹陷或突变。
// 结果四舍五入并限制在 Int16 范围内，绝不发生整数回绕。
// 所有函数都返回新的 Int16Array，绝不修改输入帧。

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

// 每帧 10ms：与 ffmpeg-decoder 的 48kHz / 480 采样每声道输出严格对应
export const PCM_FRAME_MS = 10;

/**
 * 正常交叉淡化的逐帧 progress：第 frameIndex 个混音帧（0 起）在共
 * totalFrames 帧的淡化里映射到 [0, 1] 完整闭区间——
 * 首帧恰为 0（old=1/new=0），末帧恰为 1（old=0/new=1）。
 * totalFrames <= 1 的退化淡化直接取终点 1。
 */
export function crossfadeProgress(frameIndex, totalFrames) {
  if (!Number.isInteger(totalFrames) || totalFrames <= 1) return 1;
  if (!Number.isInteger(frameIndex) || frameIndex <= 0) return 0;
  return Math.min(1, frameIndex / (totalFrames - 1));
}

/**
 * 等功率交叉淡化增益。progress ∈ [0, 1]（自动夹取）：
 * 0 → oldGain=1, newGain=0；1 → oldGain=0, newGain=1。
 */
export function equalPowerGains(progress) {
  const clamped =
    Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return {
    oldGain: Math.cos((clamped * Math.PI) / 2),
    newGain: Math.sin((clamped * Math.PI) / 2),
  };
}

function clampToInt16(value) {
  const rounded = Math.round(value);
  if (rounded > INT16_MAX) return INT16_MAX;
  if (rounded < INT16_MIN) return INT16_MIN;
  return rounded;
}

function assertFrame(frame, label) {
  if (!(frame instanceof Int16Array) || frame.length === 0) {
    throw new TypeError(`${label} 必须是非空 Int16Array PCM 帧`);
  }
}

/**
 * 逐采样混音两个格式一致的 PCM 帧。帧长度不一致（采样率 / 声道 /
 * 帧参数不同的信号）直接抛错，绝不静默截断。
 */
export function mixFrames(oldFrame, newFrame, oldGain, newGain) {
  assertFrame(oldFrame, "oldFrame");
  assertFrame(newFrame, "newFrame");
  if (oldFrame.length !== newFrame.length) {
    throw new RangeError(
      `混音帧长度不一致：${oldFrame.length} != ${newFrame.length}`
    );
  }
  const mixed = new Int16Array(oldFrame.length);
  for (let index = 0; index < mixed.length; index += 1) {
    mixed[index] = clampToInt16(
      oldFrame[index] * oldGain + newFrame[index] * newGain
    );
  }
  return mixed;
}

/**
 * 单路增益缩放（淡出尾部 / 淡入接管时使用）。
 */
export function scaleFrame(frame, gain) {
  assertFrame(frame, "frame");
  const scaled = new Int16Array(frame.length);
  for (let index = 0; index < scaled.length; index += 1) {
    scaled[index] = clampToInt16(frame[index] * gain);
  }
  return scaled;
}
