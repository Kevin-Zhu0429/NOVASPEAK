// 本地生成的低音量测试音（纯函数，可单元测试）。
// 只用于验证 LiveKit 机器人推流链路：
// 48000 Hz / 单声道 / PCM signed 16-bit / 每帧 10ms（480 采样）。
// 不读取音乐文件、不下载远程音频、不使用受版权保护的内容。

export const SAMPLE_RATE = 48000;
export const CHANNELS = 1;
export const FRAME_MS = 10;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 480

export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 30;
export const DEFAULT_DURATION_SECONDS = 5;

// 音量固定在满刻度的 8% 左右（约 -22 dBFS），避免突然过响
const DEFAULT_FREQUENCY_HZ = 440;
const DEFAULT_AMPLITUDE = 0.08;
// 首尾各 50ms 淡入淡出，避免爆音
const FADE_MS = 50;

/**
 * 校验 probe 的 duration 参数：整数 1～30 秒，未提供时取默认 5 秒。
 */
export function parseDurationSeconds(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, seconds: DEFAULT_DURATION_SECONDS };
  }

  const value = typeof raw === "number" ? raw : Number(String(raw).trim());

  if (
    !Number.isInteger(value) ||
    value < MIN_DURATION_SECONDS ||
    value > MAX_DURATION_SECONDS
  ) {
    return {
      ok: false,
      error: `duration 必须是 ${MIN_DURATION_SECONDS}～${MAX_DURATION_SECONDS} 的整数秒`,
    };
  }

  return { ok: true, seconds: value };
}

/**
 * 创建测试音生成器。frameAt(index) 是全局采样索引的纯函数，
 * 因此任意连续两帧之间相位天然连续。
 */
export function createTestTone({
  durationSeconds,
  frequencyHz = DEFAULT_FREQUENCY_HZ,
  amplitude = DEFAULT_AMPLITUDE,
} = {}) {
  const parsed = parseDurationSeconds(durationSeconds);
  if (!parsed.ok) {
    throw new RangeError(parsed.error);
  }
  if (!(amplitude > 0) || amplitude > 0.2) {
    throw new RangeError("测试音幅度必须在 (0, 0.2] 区间，保持低音量");
  }

  const seconds = parsed.seconds;
  const totalSamples = seconds * SAMPLE_RATE;
  const totalFrames = totalSamples / SAMPLES_PER_FRAME;
  const fadeSamples = (FADE_MS / 1000) * SAMPLE_RATE;
  const peak = Math.round(amplitude * 32767);
  const angularStep = (2 * Math.PI * frequencyHz) / SAMPLE_RATE;

  function envelopeAt(sampleIndex) {
    const fadeIn = sampleIndex / fadeSamples;
    const fadeOut = (totalSamples - 1 - sampleIndex) / fadeSamples;
    return Math.max(0, Math.min(1, fadeIn, fadeOut));
  }

  function frameAt(frameIndex) {
    if (
      !Number.isInteger(frameIndex) ||
      frameIndex < 0 ||
      frameIndex >= totalFrames
    ) {
      throw new RangeError("frameIndex 越界");
    }

    const frame = new Int16Array(SAMPLES_PER_FRAME);
    const base = frameIndex * SAMPLES_PER_FRAME;
    for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) {
      const sampleIndex = base + i;
      frame[i] = Math.round(
        Math.sin(sampleIndex * angularStep) * peak * envelopeAt(sampleIndex)
      );
    }
    return frame;
  }

  return {
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    samplesPerFrame: SAMPLES_PER_FRAME,
    frameMs: FRAME_MS,
    durationSeconds: seconds,
    totalFrames,
    frameAt,
  };
}
