// 有界异步 PCM 帧缓冲（DJ 交叉淡化预取下一首专用）。
//
// 生产者：下一首的 FFmpeg 解码任务逐帧 push；缓冲满时 push 挂起，
// 对解码器施加背压——内存上限 = maxFrames × 1920 字节，绝不无限增长。
// 消费者：混音循环用 take()（同步，取不到返回 null）或 pull()（异步等待）。
//
// 生命周期：
// - markEnded()：解码正常结束；消费者读完剩余帧后收到 null；
// - fail(error)：解码失败；丢弃剩余帧，pull() 以该错误拒绝，
//   挂起的 push 以 false 解除（生产者应停止）；
// - close()：预取被取消/中止；释放全部等待者，后续 pull() 以
//   FFMPEG_ABORTED 语义拒绝。close/fail 之后没有任何悬挂 Promise。

import { PCM_FRAME_VALUES } from "./ffmpeg-decoder.js";

export const PCM_FRAME_BUFFER_ERROR = Object.freeze({
  CLOSED: "FFMPEG_ABORTED",
});

function closedError() {
  const error = new Error("预取缓冲已关闭");
  error.code = PCM_FRAME_BUFFER_ERROR.CLOSED;
  return error;
}

export function createPcmFrameBuffer({
  maxFrames,
  frameValues = PCM_FRAME_VALUES,
} = {}) {
  if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
    throw new RangeError("maxFrames 必须是正整数");
  }

  const frames = [];
  let ended = false;
  let closed = false;
  let failure = null;
  const producerWaiters = new Set(); // resolve(boolean)
  const consumerWaiters = new Set(); // { resolve, reject }

  function wakeOneProducer() {
    const [first] = producerWaiters;
    if (!first) return;
    producerWaiters.delete(first);
    first(true);
  }

  function wakeOneConsumer() {
    const [first] = consumerWaiters;
    if (!first) return;
    consumerWaiters.delete(first);
    settleConsumer(first);
  }

  function settleConsumer(waiter) {
    if (frames.length > 0) {
      const frame = frames.shift();
      wakeOneProducer();
      waiter.resolve(frame);
      return;
    }
    if (failure) {
      waiter.reject(failure);
      return;
    }
    if (closed) {
      waiter.reject(closedError());
      return;
    }
    if (ended) {
      waiter.resolve(null);
      return;
    }
    consumerWaiters.add(waiter);
  }

  function releaseAllWaiters() {
    for (const resolve of producerWaiters) resolve(false);
    producerWaiters.clear();
    for (const waiter of consumerWaiters) settleConsumer(waiter);
    consumerWaiters.clear();
  }

  return {
    get size() {
      return frames.length;
    },
    get ended() {
      return ended;
    },
    get closed() {
      return closed;
    },
    get failed() {
      return failure;
    },
    get maxFrames() {
      return maxFrames;
    },
    get maxBytes() {
      return maxFrames * frameValues * 2;
    },

    /**
     * 入队一帧。返回 true 表示已接收；false 表示缓冲已关闭/失败，
     * 生产者应停止解码。缓冲满时挂起直到有空位或被关闭。
     */
    async push(frame) {
      if (
        !(frame instanceof Int16Array) ||
        frame.length !== frameValues
      ) {
        throw new TypeError(
          `push 需要长度为 ${frameValues} 的 Int16Array PCM 帧`
        );
      }
      if (ended) {
        throw new Error("markEnded 之后不允许继续 push");
      }
      for (;;) {
        if (closed || failure) return false;
        if (frames.length < maxFrames) {
          frames.push(frame);
          wakeOneConsumer();
          return true;
        }
        const hasSpace = await new Promise((resolve) => {
          producerWaiters.add(resolve);
        });
        if (!hasSpace) return false;
      }
    },

    /**
     * 同步取一帧；缓冲为空返回 null（不区分等待与结束，调用方
     * 结合 ended / failed 判断）。
     */
    take() {
      if (frames.length === 0) return null;
      const frame = frames.shift();
      wakeOneProducer();
      return frame;
    },

    /**
     * 异步取一帧：有帧返回帧；解码结束且读空返回 null；
     * 解码失败以失败原因拒绝；缓冲被关闭以 FFMPEG_ABORTED 拒绝。
     */
    pull() {
      return new Promise((resolve, reject) => {
        settleConsumer({ resolve, reject });
      });
    },

    markEnded() {
      if (ended || closed) return;
      ended = true;
      releaseAllWaiters();
    },

    fail(error) {
      if (failure || closed) return;
      failure = error instanceof Error ? error : new Error(String(error));
      frames.length = 0;
      releaseAllWaiters();
    },

    close() {
      if (closed) return;
      closed = true;
      frames.length = 0;
      releaseAllWaiters();
    },
  };
}
