import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { FFMPEG_ARGS, PCM_FORMAT, decodeMediaStreamToPcmFrames, pcmBytesToFrames } from "./ffmpeg-decoder.js";

test("FFmpeg args decode stdin to 48k mono s16le stdout without URL", () => {
  assert.deepEqual(FFMPEG_ARGS.slice(-4), ["-ar", "48000", "-f", "s16le", "pipe:1"].slice(-4));
  assert.ok(FFMPEG_ARGS.includes("pipe:0"));
  assert.ok(!FFMPEG_ARGS.join(" ").includes("http"));
});

test("PCM chunk splitter preserves remainder and flush pads final frame", () => {
  const frame = Buffer.alloc(PCM_FORMAT.bytesPerFrame);
  frame.writeInt16LE(1234, 0);
  const first = pcmBytesToFrames([frame.subarray(0, 500)]);
  assert.equal(first.frames.length, 0);
  const second = pcmBytesToFrames([first.remainder, frame.subarray(500), Buffer.from([1, 0])], { flush: true });
  assert.equal(second.frames.length, 2);
  assert.equal(second.frames[0][0], 1234);
  assert.equal(second.frames[1][0], 1);
});

test("decoder spawns with shell false and captures frames", async () => {
  let options;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  const spawn = (cmd, args, opts) => { options = opts; queueMicrotask(() => { child.stdout.end(Buffer.alloc(960)); child.emit("close", 0); }); return child; };
  const frames = [];
  await decodeMediaStreamToPcmFrames({ mediaStream: new PassThrough().end(), spawn, onFrame: async (f) => frames.push(f) });
  assert.equal(options.shell, false);
  assert.equal(frames.length, 1);
});
