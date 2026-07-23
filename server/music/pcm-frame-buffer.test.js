import test from "node:test";
import assert from "node:assert/strict";
import { createPcmFrameBuffer } from "./pcm-frame-buffer.js";
import { PCM_FRAME_BYTES, PCM_FRAME_VALUES } from "./ffmpeg-decoder.js";

function frame(value) {
  return new Int16Array(PCM_FRAME_VALUES).fill(value);
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("帧大小与内存上限计算：48kHz/双声道/s16le/10ms", () => {
  // 每帧 480 采样 × 2 声道 × 2 字节 = 1920 字节
  assert.equal(PCM_FRAME_VALUES, 960);
  assert.equal(PCM_FRAME_BYTES, 1920);
  // 6 秒 = 600 帧 = 1,152,000 字节；8 秒 = 800 帧 = 1,536,000 字节（< 1.5 MiB）
  const sixSeconds = createPcmFrameBuffer({ maxFrames: 600 });
  assert.equal(sixSeconds.maxBytes, 1_152_000);
  const eightSeconds = createPcmFrameBuffer({ maxFrames: 800 });
  assert.equal(eightSeconds.maxBytes, 1_536_000);
});

test("有界帧缓冲不会无限增长：满后生产者等待，消费后继续", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 2 });
  assert.equal(await buffer.push(frame(1)), true);
  assert.equal(await buffer.push(frame(2)), true);
  assert.equal(buffer.size, 2);

  let thirdSettled = false;
  const third = buffer.push(frame(3)).then((accepted) => {
    thirdSettled = true;
    return accepted;
  });
  await tick();
  assert.equal(thirdSettled, false); // 缓冲满：push 被背压挂起
  assert.equal(buffer.size, 2);

  assert.equal(buffer.take()[0], 1); // 消费一帧后生产者继续
  assert.equal(await third, true);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.take()[0], 2);
  assert.equal(buffer.take()[0], 3);
  assert.equal(buffer.take(), null);
});

test("Abort（close）能解除挂起的生产者，close 后无悬挂 Promise", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 1 });
  await buffer.push(frame(1));
  const blocked = buffer.push(frame(2));
  const blockedPull = createPcmFrameBuffer({ maxFrames: 1 }); // 独立：消费者挂起场景
  const pullPromise = blockedPull.pull();

  buffer.close();
  blockedPull.close();

  assert.equal(await blocked, false); // 生产者被解除并得知缓冲已关闭
  await assert.rejects(pullPromise, (error) => error.code === "FFMPEG_ABORTED");
  assert.equal(await buffer.push(frame(3)), false); // close 后 push 直接拒收
  await assert.rejects(buffer.pull(), (error) => error.code === "FFMPEG_ABORTED");
});

test("fail 丢弃剩余帧并把失败原因传给消费者", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 4 });
  await buffer.push(frame(1));
  const cause = new Error("解码失败");
  cause.code = "FFMPEG_DECODE_FAILED";
  buffer.fail(cause);
  assert.equal(buffer.size, 0);
  await assert.rejects(buffer.pull(), (error) => error.code === "FFMPEG_DECODE_FAILED");
  assert.equal(await buffer.push(frame(2)), false);
});

test("markEnded 后消费者读完剩余帧收到 null", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 4 });
  await buffer.push(frame(7));
  buffer.markEnded();
  assert.equal((await buffer.pull())[0], 7);
  assert.equal(await buffer.pull(), null);
  assert.equal(await buffer.pull(), null); // 可重复读 null，不挂起
});

test("pull 在空缓冲上等待，push 后被唤醒", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 4 });
  const waiting = buffer.pull();
  await tick();
  await buffer.push(frame(9));
  assert.equal((await waiting)[0], 9);
});

test("push 校验帧格式：长度不符或非 Int16Array 抛错", async () => {
  const buffer = createPcmFrameBuffer({ maxFrames: 2 });
  await assert.rejects(() => buffer.push(new Int16Array(4)), TypeError);
  await assert.rejects(() => buffer.push([1, 2, 3]), TypeError);
});
