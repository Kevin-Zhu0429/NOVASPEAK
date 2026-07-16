import { spawn as defaultSpawn } from "node:child_process";
import { once } from "node:events";

export const PCM_FORMAT = Object.freeze({ sampleRate: 48000, channels: 1, samplesPerFrame: 480, bytesPerFrame: 960 });
export const FFMPEG_ERROR = Object.freeze({ NOT_FOUND: "FFMPEG_NOT_FOUND", START_FAILED: "FFMPEG_START_FAILED", DECODE_FAILED: "FFMPEG_DECODE_FAILED", ABORTED: "MEDIA_ABORTED" });
export class FfmpegDecodeError extends Error { constructor(code, message) { super(message); this.name = "FfmpegDecodeError"; this.code = code; } }
function buildSafeFfmpegEnv(baseEnv = process.env) {
  const safe = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "HOME", "TMP", "TEMP", "TMPDIR"]) {
    if (typeof baseEnv[key] === "string") safe[key] = baseEnv[key];
  }
  return safe;
}

export const FFMPEG_ARGS = Object.freeze(["-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"]);

export function pcmBytesToFrames(chunks, { flush = false } = {}) {
  const buffer = Buffer.concat(chunks);
  const frames = [];
  let offset = 0;
  while (offset + PCM_FORMAT.bytesPerFrame <= buffer.length) {
    const samples = new Int16Array(PCM_FORMAT.samplesPerFrame);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(offset + i * 2);
    frames.push(samples);
    offset += PCM_FORMAT.bytesPerFrame;
  }
  let remainder = buffer.subarray(offset);
  if (flush && remainder.length) {
    const padded = Buffer.alloc(PCM_FORMAT.bytesPerFrame);
    remainder.copy(padded);
    const samples = new Int16Array(PCM_FORMAT.samplesPerFrame);
    for (let i = 0; i < samples.length; i += 1) samples[i] = padded.readInt16LE(i * 2);
    frames.push(samples);
    remainder = Buffer.alloc(0);
  }
  return { frames, remainder };
}

function sanitizeSpawnError(error) {
  if (error?.code === "ENOENT") return new FfmpegDecodeError(FFMPEG_ERROR.NOT_FOUND, "FFmpeg 不可用");
  return new FfmpegDecodeError(FFMPEG_ERROR.START_FAILED, "FFmpeg 启动失败");
}

export async function decodeMediaStreamToPcmFrames({ mediaStream, onFrame, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", spawn = defaultSpawn, signal = null, killTimeoutMs = 3000 } = {}) {
  const child = spawn(ffmpegPath, [...FFMPEG_ARGS], { shell: false, stdio: ["pipe", "pipe", "pipe"], env: buildSafeFfmpegEnv(process.env) });
  let stderr = Buffer.alloc(0);
  let spawnError = null;
  child.once("error", (error) => { spawnError = sanitizeSpawnError(error); });
  child.stderr?.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]).subarray(-8192); });
  const closePromise = once(child, "close");
  const abort = () => { child.stdin?.destroy(); child.stdout?.destroy(); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), killTimeoutMs).unref?.(); };
  if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  mediaStream.on("error", (e) => child.stdin?.destroy(e));
  mediaStream.pipe(child.stdin);
  let remainder = Buffer.alloc(0); let framesSent = 0;
  try {
    for await (const chunk of child.stdout) {
      const framed = pcmBytesToFrames([remainder, chunk]);
      remainder = framed.remainder;
      for (const frame of framed.frames) { await onFrame(frame); framesSent += 1; }
    }
    const flushed = pcmBytesToFrames([remainder], { flush: true });
    for (const frame of flushed.frames) { await onFrame(frame); framesSent += 1; }
    const [code] = await closePromise;
    if (signal?.aborted) throw new FfmpegDecodeError(FFMPEG_ERROR.ABORTED, "解码已中止");
    if (spawnError) throw spawnError;
    if (code !== 0) throw new FfmpegDecodeError(FFMPEG_ERROR.DECODE_FAILED, "音频解码失败");
    return { framesSent };
  } finally { signal?.removeEventListener?.("abort", abort); }
}
