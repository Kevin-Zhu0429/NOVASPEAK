import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import {
  DECODER_ERROR,
  FFMPEG_DECODE_ARGS,
  MUSIC_BOT_SOURCE_GAIN,
  PCM_CHANNELS,
  PCM_FRAME_BYTES,
  PCM_FRAME_SAMPLES,
  PCM_FRAME_VALUES,
  createFrameChunker,
  decodeMediaToFrames,
} from "./ffmpeg-decoder.js";
import { FFMPEG_ERROR } from "./ffmpeg-runtime.js";
import {
  MEDIA_ERROR,
  createByteLimitTransform,
} from "./playback-source.js";

// 无停滞计时的 byte-limit（测试里手动控制节奏）
function makeByteLimit(options = {}) {
  return createByteLimitTransform({ stallTimeoutMs: 0, ...options });
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signalName) => {
    child.killSignals.push(signalName);
  };
  return child;
}

function makeSpawn(child, { onSpawn = null, spawnCalls = [] } = {}) {
  return (command, args, options) => {
    spawnCalls.push({ command, args, options });
    queueMicrotask(() => onSpawn?.(child));
    return child;
  };
}

// 让 fake ffmpeg 表现为：读完 stdin 后输出 pcmBytes 并以 exitCode 退出
function scriptEcho(child, { pcm = Buffer.alloc(0), exitCode = 0 } = {}) {
  child.stdin.resume();
  child.stdin.on("end", () => {
    if (pcm.length) child.stdout.write(pcm);
    child.stdout.end();
    setImmediate(() => child.emit("close", exitCode, null));
  });
}

function pcmOf(totalBytes, fill = 1) {
  return Buffer.alloc(totalBytes, fill);
}

// ---------- 分帧器 ----------

test("frame chunker：任意 chunk 切分得到正确双声道 1920 字节帧 + remainder", async () => {
  const chunker = createFrameChunker();
  const frames = [];
  const done = (async () => {
    for await (const frame of chunker) frames.push(frame);
  })();

  // 总计 4420 字节，按奇怪边界切分：1920*2=3840 整帧 + 580 remainder
  const full = Buffer.alloc(4420);
  for (let i = 0; i < full.length; i += 1) full[i] = i % 251;
  chunker.write(full.subarray(0, 7));
  chunker.write(full.subarray(7, 1000));
  chunker.write(full.subarray(1000, 1001));
  chunker.write(full.subarray(1001, 4420));
  chunker.end();
  await done;

  assert.equal(frames.length, 3);
  for (const frame of frames) {
    assert.ok(frame instanceof Int16Array);
    assert.equal(frame.length, PCM_FRAME_VALUES);
  }
  // 前两帧与源字节一致
  const joined = Buffer.concat(
    frames.map((frame) => Buffer.from(frame.buffer, frame.byteOffset, PCM_FRAME_BYTES))
  );
  assert.ok(joined.subarray(0, 3840).equals(full.subarray(0, 3840)));
  // 末尾 580 字节补零成完整一帧（固定行为）
  assert.ok(joined.subarray(3840, 3840 + 580).equals(full.subarray(3840)));
  assert.ok(
    joined.subarray(3840 + 580).equals(Buffer.alloc(PCM_FRAME_BYTES - 580))
  );
});

// ---------- 成功路径 ----------

test("成功解码：参数安全 + 帧数正确", async () => {
  const child = makeFakeChild();
  const spawnCalls = [];
  scriptEcho(child, { pcm: pcmOf(PCM_FRAME_BYTES * 5) });

  const frames = [];
  const result = await decodeMediaToFrames({
    ffmpegPath: "/fake/ffmpeg",
    mediaStream: Readable.from([Buffer.from("compressed-audio-data")]),
    byteLimit: makeByteLimit(),
    onFrame: async (frame) => frames.push(frame),
    env: { HOME: "/home/x", MUSIC_CREDENTIAL_KEY: "secret" },
    spawnImpl: makeSpawn(child, { spawnCalls }),
  });

  assert.equal(result.framesDelivered, 5);
  assert.equal(frames.length, 5);

  const call = spawnCalls[0];
  assert.equal(call.command, "/fake/ffmpeg");
  assert.deepEqual(call.args, [...FFMPEG_DECODE_ARGS]);
  // 48k / 双声道 / s16le / stdin 输入
  assert.ok(call.args.includes("-ar") && call.args.includes("48000"));
  assert.ok(call.args.includes("-ac") && call.args.includes(String(PCM_CHANNELS)));
  assert.equal(PCM_FRAME_SAMPLES, 480);
  assert.equal(PCM_FRAME_VALUES, 960);
  assert.ok(call.args.includes("s16le"));
  assert.ok(call.args.includes("pipe:0"));
  // 机器人源音轨固定衰减到 20%；客户端默认 10% 时最终约为原始 PCM 的 2%。
  assert.equal(MUSIC_BOT_SOURCE_GAIN, 0.2);
  const filterIndex = call.args.indexOf("-filter:a");
  assert.ok(filterIndex > -1);
  assert.equal(call.args[filterIndex + 1], "volume=0.2");
  // shell:false + 环境白名单（无密钥），URL/Cookie 不在 argv
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.env, { HOME: "/home/x" });
  assert.ok(!call.args.some((arg) => arg.includes("http")));
});

// ---------- 失败路径 ----------

test("spawn 同步抛出 ENOENT → FFMPEG_NOT_AVAILABLE", async () => {
  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/missing/ffmpeg",
        mediaStream: Readable.from([Buffer.alloc(1)]),
        byteLimit: makeByteLimit(),
        onFrame: async () => {},
        spawnImpl: () => {
          const error = new Error("spawn ENOENT");
          error.code = "ENOENT";
          throw error;
        },
      }),
    (error) => error.code === FFMPEG_ERROR.NOT_AVAILABLE
  );
});

test("异步 spawn error（error 事件）+ 随后 close：只结算一次", async () => {
  const child = makeFakeChild();
  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: Readable.from([Buffer.alloc(4)]),
        byteLimit: makeByteLimit(),
        onFrame: async () => {},
        spawnImpl: makeSpawn(child, {
          onSpawn: (spawned) => {
            const error = new Error("spawn ENOENT");
            error.code = "ENOENT";
            // error 后 stdin/stdout 也会随之关闭
            spawned.stdin.destroy();
            spawned.stdout.end();
            spawned.emit("error", error);
            spawned.emit("close", 1, null);
          },
        }),
      }),
    (error) => error.code === FFMPEG_ERROR.NOT_AVAILABLE
  );
});

test("非零退出码 → FFMPEG_DECODE_FAILED，stderr 尾部只留内部字段", async () => {
  const child = makeFakeChild();
  child.stdin.resume();
  child.stdin.on("end", () => {
    child.stderr.write("Invalid data found when processing input\n");
    child.stdout.end();
    setImmediate(() => child.emit("close", 1, null));
  });

  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: Readable.from([Buffer.from("corrupted")]),
        byteLimit: makeByteLimit(),
        onFrame: async () => {},
        spawnImpl: makeSpawn(child),
      }),
    (error) =>
      error.code === DECODER_ERROR.DECODE_FAILED &&
      !error.message.includes("Invalid data") &&
      typeof error.stderrTail === "string"
  );
});

test("EPIPE（FFmpeg 先退出且失败）→ DECODE_FAILED", async () => {
  const child = makeFakeChild();
  const media = new PassThrough();
  // FFmpeg 立刻失败退出，stdin 报 EPIPE
  queueMicrotask(() => {
    const epipe = new Error("write EPIPE");
    epipe.code = "EPIPE";
    child.stdout.end();
    child.stdin.destroy(epipe);
    setImmediate(() => child.emit("close", 1, null));
  });
  // 持续写入的媒体流
  media.write(Buffer.alloc(1024));
  setTimeout(() => media.end(Buffer.alloc(10)), 20);

  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: media,
        byteLimit: makeByteLimit(),
        onFrame: async () => {},
        spawnImpl: makeSpawn(child),
      }),
    (error) => error.code === DECODER_ERROR.DECODE_FAILED
  );
});

test("媒体流中途错误 → MEDIA_PIPELINE_FAILED（保留 MediaSourceError 原分类）", async () => {
  // 普通媒体错误
  const child = makeFakeChild();
  child.stdin.resume();
  child.stdin.on("close", () => {
    child.stdout.end();
    setImmediate(() => child.emit("close", 1, null));
  });
  const media = new PassThrough();
  media.write(Buffer.alloc(10));
  setTimeout(() => media.destroy(new Error("cdn dropped")), 10);

  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: media,
        byteLimit: makeByteLimit(),
        onFrame: async () => {},
        spawnImpl: makeSpawn(child),
      }),
    (error) => error.code === DECODER_ERROR.PIPELINE_FAILED
  );
  assert.deepEqual(child.killSignals, ["SIGTERM"]);

  // byte-limit 超限：MediaSourceError 原样透出
  const child2 = makeFakeChild();
  child2.stdin.resume();
  child2.stdin.on("close", () => {
    child2.stdout.end();
    setImmediate(() => child2.emit("close", 1, null));
  });
  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: Readable.from([Buffer.alloc(2048)]),
        byteLimit: makeByteLimit({ maxBytes: 1024 }),
        onFrame: async () => {},
        spawnImpl: makeSpawn(child2),
      }),
    (error) => error.code === MEDIA_ERROR.TOO_LARGE
  );
  assert.deepEqual(child2.killSignals, ["SIGTERM"]);
});

test("Abort：SIGTERM 只发一次、kill timer 清理、报 FFMPEG_ABORTED", async () => {
  const child = makeFakeChild();
  child.stdin.resume();
  const controller = new AbortController();
  // kill 后模拟进程退出
  child.kill = (signalName) => {
    child.killSignals.push(signalName);
    setImmediate(() => {
      child.stdout.end();
      child.stdin.destroy();
      child.emit("close", null, "SIGTERM");
    });
  };

  const media = new PassThrough();
  media.write(Buffer.alloc(64));
  const pending = decodeMediaToFrames({
    ffmpegPath: "/fake/ffmpeg",
    mediaStream: media,
    byteLimit: makeByteLimit(),
    onFrame: async () => {},
    signal: controller.signal,
    spawnImpl: makeSpawn(child),
  });

  setTimeout(() => {
    controller.abort();
    controller.abort(); // 重复 abort 无副作用
  }, 10);

  await assert.rejects(
    () => pending,
    (error) => error.code === DECODER_ERROR.ABORTED
  );
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  media.destroy();
});

test("onFrame（captureFrame 类）失败：终止解码并透出错误", async () => {
  const child = makeFakeChild();
  child.stdin.resume();
  child.stdout.write(pcmOf(960 * 3));
  child.kill = (signalName) => {
    child.killSignals.push(signalName);
    setImmediate(() => {
      child.stdout.end();
      child.stdin.destroy();
      child.emit("close", null, "SIGTERM");
    });
  };

  const media = new PassThrough();
  media.write(Buffer.alloc(16));
  const captureError = new Error("capture failed");
  await assert.rejects(
    () =>
      decodeMediaToFrames({
        ffmpegPath: "/fake/ffmpeg",
        mediaStream: media,
        byteLimit: makeByteLimit(),
        onFrame: async () => {
          throw captureError;
        },
        spawnImpl: makeSpawn(child),
      }),
    (error) =>
      error.code === DECODER_ERROR.PIPELINE_FAILED &&
      error.cause === captureError
  );
  assert.ok(child.killSignals.includes("SIGTERM"));
  media.destroy();
});

test("整个流程无 unhandledRejection / 未处理 error 事件", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // 跑一次失败路径 + 一次成功路径
    const failChild = makeFakeChild();
    failChild.stdin.resume();
    failChild.stdin.on("end", () => {
      failChild.stdout.end();
      setImmediate(() => failChild.emit("close", 1, null));
    });
    await decodeMediaToFrames({
      ffmpegPath: "/fake/ffmpeg",
      mediaStream: Readable.from([Buffer.alloc(8)]),
      byteLimit: makeByteLimit(),
      onFrame: async () => {},
      spawnImpl: makeSpawn(failChild),
    }).catch(() => {});

    const okChild = makeFakeChild();
    scriptEcho(okChild, { pcm: pcmOf(960 * 2) });
    await decodeMediaToFrames({
      ffmpegPath: "/fake/ffmpeg",
      mediaStream: Readable.from([Buffer.alloc(8)]),
      byteLimit: makeByteLimit(),
      onFrame: async () => {},
      spawnImpl: makeSpawn(okChild),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
