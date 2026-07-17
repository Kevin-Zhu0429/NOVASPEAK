// FFmpeg 流式解码（Stage 5B v2 全新实现）。
//
// 数据流：媒体 Readable → byte-limit Transform → FFmpeg stdin；
// FFmpeg stdout（s16le PCM）→ 1920 字节分帧 → await onFrame(帧)。
//
// 输出固定：48000Hz / 双声道 / signed 16-bit LE / 10ms 帧
// （每声道 480 采样，共 960 个 Int16 = 1920 字节）。
//
// 安全：shell:false；URL 绝不进入 argv（媒体从 stdin 流入）；
// Cookie 绝不进入 argv/env（子进程环境走白名单）；
// stderr 只保留末尾 8 KiB 供服务端日志，绝不返回客户端。
//
// ChildProcess 状态机（v2 最高优先级）：
// error/close 任意顺序只结算一次；EPIPE、stdout error、媒体流错误、
// Abort、kill 超时全部显式协调；不产生 unhandledRejection / 未处理
// error 事件；绝不 process.exit、绝不关闭 HTTP server。

import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildSafeFfmpegEnv, FFMPEG_ERROR } from "./ffmpeg-runtime.js";
import { MediaSourceError } from "./playback-source.js";

export const DECODER_ERROR = Object.freeze({
  START_FAILED: "FFMPEG_START_FAILED",
  DECODE_FAILED: "FFMPEG_DECODE_FAILED",
  ABORTED: "FFMPEG_ABORTED",
  PIPELINE_FAILED: "MEDIA_PIPELINE_FAILED",
});

export class DecoderError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DecoderError";
    this.code = code;
  }
}

export const PCM_SAMPLE_RATE = 48000;
export const PCM_CHANNELS = 2;
// 每声道每帧采样数；LiveKit AudioFrame 的 samplesPerChannel 使用此值。
export const PCM_FRAME_SAMPLES = 480;
export const PCM_FRAME_VALUES = PCM_FRAME_SAMPLES * PCM_CHANNELS;
export const PCM_FRAME_BYTES = PCM_FRAME_VALUES * 2; // 1920

export const FFMPEG_DECODE_ARGS = Object.freeze([
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  "pipe:0",
  "-map",
  "0:a:0",
  "-vn",
  "-sn",
  "-dn",
  "-ac",
  String(PCM_CHANNELS),
  "-ar",
  String(PCM_SAMPLE_RATE),
  "-f",
  "s16le",
  "pipe:1",
]);

const STDERR_TAIL_LIMIT = 8 * 1024;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;

/**
 * PCM 分帧 Transform：stdout 的 chunk 边界与帧边界无关，
 * remainder 跨 chunk 保存；结尾不足 1920 字节时补零成完整一帧
 * （行为固定，有测试锁定）。
 */
export function createFrameChunker() {
  let remainder = Buffer.alloc(0);
  return new Transform({
    readableObjectMode: true,
    transform(chunk, _encoding, callback) {
      let buffer = remainder.length
        ? Buffer.concat([remainder, chunk])
        : chunk;
      let offset = 0;
      while (buffer.length - offset >= PCM_FRAME_BYTES) {
        this.push(
          new Int16Array(
            // 复制到独立 ArrayBuffer，保证帧不共享底层内存
            Uint8Array.prototype.slice
              .call(buffer, offset, offset + PCM_FRAME_BYTES).buffer
          )
        );
        offset += PCM_FRAME_BYTES;
      }
      remainder = buffer.subarray(offset);
      callback();
    },
    flush(callback) {
      if (remainder.length > 0) {
        const padded = Buffer.alloc(PCM_FRAME_BYTES);
        remainder.copy(padded);
        this.push(new Int16Array(padded.buffer, padded.byteOffset, PCM_FRAME_VALUES));
        remainder = Buffer.alloc(0);
      }
      callback();
    },
  });
}

/**
 * 解码整首歌曲：媒体流 → FFmpeg → 逐帧 await onFrame。
 * 依赖全部可注入（spawnImpl / 媒体流 / byte-limit），便于 mock 测试。
 *
 * @returns {Promise<{ framesDelivered: number }>}
 */
export async function decodeMediaToFrames({
  ffmpegPath,
  mediaStream,
  byteLimit,
  onFrame,
  signal = null,
  env = process.env,
  spawnImpl = spawn,
  killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
}) {
  let child;
  try {
    child = spawnImpl(ffmpegPath, [...FFMPEG_DECODE_ARGS], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSafeFfmpegEnv(env),
      windowsHide: true,
    });
  } catch (error) {
    throw new DecoderError(
      error?.code === "ENOENT"
        ? FFMPEG_ERROR.NOT_AVAILABLE
        : DECODER_ERROR.START_FAILED,
      "无法启动解码器"
    );
  }

  // stderr 尾部（服务端日志用，不返回客户端）
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  });
  child.stderr?.on("error", () => {});
  // EPIPE 等 stdin/stdout 错误：吞掉裸事件防止 unhandled，
  // 实际失败由 pipeline / exit 结果统一分类
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});

  // exit 协调：error 与 close 任意顺序，只记录一次结果，永不 reject
  const exitPromise = new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({ kind: "spawn-error", error }));
    child.once("close", (code, signalName) =>
      settle({ kind: "close", code, signalName })
    );
  });

  // 终止协调：Abort / kill 超时各自最多执行一次
  let terminated = false;
  let killTimer = null;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已退出
      }
    }, killTimeoutMs);
    killTimer.unref?.();
  };
  const onAbort = () => terminate();
  signal?.addEventListener("abort", onAbort, { once: true });

  // 输入管道：媒体 → 字节上限 → stdin（错误捕获为值，不抛出）
  const inputPromise = pipeline(mediaStream, byteLimit, child.stdin).then(
    () => null,
    (error) => {
      // FFmpeg 自己正常/异常退出时 stdin 常见 EPIPE / premature close，
      // 此时真正结果由 exit code 判断。除此之外说明上游媒体永久失败，
      // 必须主动结束 FFmpeg，避免它继续等待 stdin 导致 worker 悬挂。
      if (
        error?.code !== "EPIPE" &&
        error?.code !== "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        terminate();
      }
      return error;
    }
  );

  // 输出管道：stdout → 分帧 → 逐帧 await onFrame
  const chunker = createFrameChunker();
  const outputPipePromise = pipeline(child.stdout, chunker).then(
    () => null,
    (error) => error
  );
  let framesDelivered = 0;
  const consumePromise = (async () => {
    try {
      for await (const frame of chunker) {
        if (signal?.aborted) return null;
        await onFrame(frame);
        framesDelivered += 1;
      }
      return null;
    } catch (error) {
      // onFrame 失败（例如 LiveKit captureFrame）→ 终止解码
      terminate();
      return error;
    }
  })();

  let inputError;
  let outputPipeError;
  let consumeError;
  let exitResult;
  try {
    [inputError, outputPipeError, consumeError, exitResult] =
      await Promise.all([
        inputPromise,
        outputPipePromise,
        consumePromise,
        exitPromise,
      ]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    // 兜底销毁（destroy 自身可重入安全）
    try {
      if (!mediaStream.destroyed) mediaStream.destroy();
    } catch {
      // 忽略清理失败
    }
  }

  // ---------- 结果分类（顺序即优先级） ----------

  if (signal?.aborted) {
    throw new DecoderError(DECODER_ERROR.ABORTED, "播放已中止");
  }

  if (exitResult.kind === "spawn-error") {
    throw new DecoderError(
      exitResult.error?.code === "ENOENT"
        ? FFMPEG_ERROR.NOT_AVAILABLE
        : DECODER_ERROR.START_FAILED,
      "无法启动解码器"
    );
  }

  // 媒体侧错误（含 byte-limit 的 TOO_LARGE / STALL）优先透出原始分类
  if (inputError instanceof MediaSourceError) {
    throw inputError;
  }

  if (consumeError) {
    throw consumeError instanceof DecoderError ||
      consumeError instanceof MediaSourceError
      ? consumeError
      : new DecoderError(
          DECODER_ERROR.PIPELINE_FAILED,
          "音频推送失败",
          { cause: consumeError }
        );
  }

  // EPIPE / premature close 说明是 FFmpeg 先退出导致输入中断，
  // 真正原因看退出码；其他输入错误说明媒体侧先断开
  const isDownstreamInputBreak =
    inputError?.code === "EPIPE" ||
    inputError?.code === "ERR_STREAM_PREMATURE_CLOSE";
  if (inputError && !isDownstreamInputBreak) {
    throw new DecoderError(
      DECODER_ERROR.PIPELINE_FAILED,
      "歌曲数据传输中断",
      { cause: inputError }
    );
  }

  if (exitResult.code !== 0) {
    const error = new DecoderError(
      DECODER_ERROR.DECODE_FAILED,
      "歌曲解码失败"
    );
    // 供服务端日志排查；调用方不得透出给客户端
    error.stderrTail = stderrTail;
    throw error;
  }

  // EPIPE 但 FFmpeg 正常退出（提前读完输入）：解码本身成功

  if (outputPipeError) {
    throw new DecoderError(
      DECODER_ERROR.PIPELINE_FAILED,
      "解码输出中断",
      { cause: outputPipeError }
    );
  }

  return { framesDelivered };
}
