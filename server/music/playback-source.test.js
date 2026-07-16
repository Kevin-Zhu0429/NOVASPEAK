import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  MEDIA_ERROR,
  createByteLimitTransform,
  isAllowedMediaUrl,
  mediaUrlHostname,
  openPlaybackStream,
} from "./playback-source.js";

function webStreamFrom(chunks, { chunkDelayMs = 0 } = {}) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function makeResponse({
  status = 200,
  headers = {},
  chunks = [new Uint8Array([1, 2, 3])],
  bodyDelayMs = 0,
} = {}) {
  let cancelled = false;
  const body = webStreamFrom(chunks, { chunkDelayMs: bodyDelayMs });
  const originalCancel = body.cancel.bind(body);
  body.cancel = async (reason) => {
    cancelled = true;
    return originalCancel(reason);
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body,
    wasCancelled: () => cancelled,
  };
}

async function collect(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

// ---------- URL 校验 ----------

test("官方媒体域及严格子域允许", () => {
  for (const url of [
    "https://music.126.net/a.mp3",
    "https://m701.music.126.net/a.mp3",
    "http://m10.music.126.net/x/y.mp3",
    "https://music.163.com/song/media/outer.mp3",
    "https://interface.music.163.com/a.mp3",
  ]) {
    assert.equal(isAllowedMediaUrl(url), true, url);
  }
});

test("伪造后缀与非网易云域拒绝", () => {
  for (const url of [
    "https://music.126.net.evil.com/a.mp3",
    "https://evil-music.126.net.attacker.io/a.mp3",
    "https://notmusic.126.net.example.com/a.mp3",
    "https://example.com/music.126.net/a.mp3",
    "https://xmusic.163.com.evil.net/a.mp3",
  ]) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
  // 注意 xmusic.163.com 不是 music.163.com 的子域
  assert.equal(isAllowedMediaUrl("https://xmusic.163.com/a.mp3"), false);
});

test("IP/localhost/危险协议/带凭据 URL 拒绝", () => {
  for (const url of [
    "https://127.0.0.1/a.mp3",
    "https://192.168.1.1/a.mp3",
    "https://[::1]/a.mp3",
    "https://localhost/a.mp3",
    "https://sub.localhost/a.mp3",
    "file:///etc/passwd",
    "data:audio/mp3;base64,AAAA",
    "ftp://music.126.net/a.mp3",
    "javascript:alert(1)",
    "https://user:pass@music.126.net/a.mp3",
    "not-a-url",
    "",
  ]) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
});

test("mediaUrlHostname 只返回主机名", () => {
  assert.equal(
    mediaUrlHostname("https://m701.music.126.net/secret/path?token=x"),
    "m701.music.126.net"
  );
  assert.equal(mediaUrlHostname("bad"), "invalid-url");
});

// ---------- 重定向 ----------

test("重定向逐跳验证：跳向非法域被拒绝，且重定向 body 被释放", async () => {
  const redirect = makeResponse({
    status: 302,
    headers: { location: "https://evil.example.com/a.mp3" },
  });
  const fetchImpl = async () => redirect;

  await assert.rejects(
    () =>
      openPlaybackStream("https://m701.music.126.net/a.mp3", { fetchImpl }),
    (error) => error.code === MEDIA_ERROR.URL_REJECTED
  );
  assert.equal(redirect.wasCancelled(), true);
});

test("合法重定向跟随并成功读取，最终字节一致", async () => {
  const target = makeResponse({
    chunks: [new Uint8Array([7, 8]), new Uint8Array([9])],
  });
  const redirect = makeResponse({
    status: 301,
    headers: { location: "https://m702.music.126.net/real.mp3" },
  });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return urls.length === 1 ? redirect : target;
  };

  const stream = await openPlaybackStream(
    "https://m701.music.126.net/a.mp3",
    { fetchImpl }
  );
  const data = await collect(stream);
  assert.deepEqual([...data], [7, 8, 9]);
  assert.equal(redirect.wasCancelled(), true);
  assert.equal(urls[1], "https://m702.music.126.net/real.mp3");
});

test("循环重定向超过 5 次拒绝", async () => {
  const fetchImpl = async () =>
    makeResponse({
      status: 302,
      headers: { location: "https://m701.music.126.net/loop.mp3" },
    });
  await assert.rejects(
    () =>
      openPlaybackStream("https://m701.music.126.net/a.mp3", { fetchImpl }),
    (error) => error.code === MEDIA_ERROR.URL_REJECTED
  );
});

// ---------- 超时与中止 ----------

test("headerTimeout 只作用于响应头：body 慢速输出不受影响", async () => {
  // Response 立即返回，但 body 每个 chunk 间隔 40ms、总时长远超 headerTimeout(30ms)
  const fetchImpl = async () =>
    makeResponse({
      chunks: Array.from({ length: 5 }, (_, i) => new Uint8Array([i])),
      bodyDelayMs: 40,
    });
  const stream = await openPlaybackStream(
    "https://m701.music.126.net/a.mp3",
    { fetchImpl, headerTimeoutMs: 30 }
  );
  const data = await collect(stream);
  assert.deepEqual([...data], [0, 1, 2, 3, 4]);
});

test("fetch 超过 headerTimeout 才返回 → MEDIA_HEADER_TIMEOUT", async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new Error("aborted by signal"))
      );
    });
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(
      () =>
        openPlaybackStream("https://m701.music.126.net/a.mp3", {
          fetchImpl,
          headerTimeoutMs: 30,
        }),
      (error) => error.code === MEDIA_ERROR.HEADER_TIMEOUT
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("外部 abort → MEDIA_ABORTED（头阶段）或流销毁（body 阶段）", async () => {
  // 头阶段 abort
  const controller = new AbortController();
  const fetchImpl = (url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const pending = openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl,
    signal: controller.signal,
    headerTimeoutMs: 5_000,
  });
  controller.abort();
  await assert.rejects(
    () => pending,
    (error) => error.code === MEDIA_ERROR.ABORTED
  );

  // body 阶段 abort：Node 流被销毁
  const bodyController = new AbortController();
  const stream = await openPlaybackStream(
    "https://m701.music.126.net/a.mp3",
    {
      fetchImpl: async () =>
        makeResponse({
          chunks: Array.from({ length: 100 }, () => new Uint8Array(10)),
          bodyDelayMs: 10,
        }),
      signal: bodyController.signal,
    }
  );
  setTimeout(() => bodyController.abort(), 20);
  await assert.rejects(async () => {
    await collect(stream);
  });
});

test("非 2xx 响应 → MEDIA_FETCH_FAILED 且释放 body", async () => {
  const response = makeResponse({ status: 403 });
  await assert.rejects(
    () =>
      openPlaybackStream("https://m701.music.126.net/a.mp3", {
        fetchImpl: async () => response,
      }),
    (error) => error.code === MEDIA_ERROR.FETCH_FAILED
  );
  assert.equal(response.wasCancelled(), true);
});

// ---------- byte-limit Transform 与背压 ----------

test("256 KiB 慢消费者：字节完全一致、不挂起、不丢不重", async () => {
  const chunkSize = 16 * 1024;
  const chunkCount = 16; // 256 KiB
  const input = Array.from({ length: chunkCount }, (_, i) =>
    Buffer.alloc(chunkSize, i)
  );

  const stream = await openPlaybackStream(
    "https://m701.music.126.net/big.mp3",
    {
      fetchImpl: async () =>
        makeResponse({ chunks: input.map((b) => new Uint8Array(b)) }),
    }
  );
  const limiter = createByteLimitTransform({ stallTimeoutMs: 5_000 });
  stream.pipe(limiter);

  const received = [];
  for await (const chunk of limiter) {
    received.push(chunk);
    // 故意放慢消费，验证背压
    await delay(5);
  }
  const output = Buffer.concat(received);
  const expected = Buffer.concat(input);
  assert.equal(output.length, expected.length);
  assert.ok(output.equals(expected));
});

test("超过 maxBytes → MEDIA_TOO_LARGE", async () => {
  const limiter = createByteLimitTransform({
    maxBytes: 1024,
    stallTimeoutMs: 5_000,
  });
  const stream = await openPlaybackStream(
    "https://m701.music.126.net/huge.mp3",
    {
      fetchImpl: async () =>
        makeResponse({
          chunks: Array.from({ length: 10 }, () => new Uint8Array(512)),
        }),
    }
  );
  stream.pipe(limiter);
  await assert.rejects(
    async () => {
      for await (const _chunk of limiter) {
        // 消费直到超限
      }
    },
    (error) => error.code === MEDIA_ERROR.TOO_LARGE
  );
});

test("body 长时间无数据 → MEDIA_STALL_TIMEOUT", async () => {
  const limiter = createByteLimitTransform({ stallTimeoutMs: 40 });
  // 手写一个只发一个 chunk 后停滞的流
  const { Readable } = await import("node:stream");
  const stalled = new Readable({
    read() {
      if (!this.pushedOnce) {
        this.pushedOnce = true;
        this.push(Buffer.from([1]));
      }
      // 之后永不 push → 停滞
    },
  });
  stalled.pipe(limiter);
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of limiter) {
          // 等待停滞触发
        }
      },
      (error) => error.code === MEDIA_ERROR.STALL_TIMEOUT
    );
  } finally {
    clearTimeout(keepAlive);
    stalled.destroy();
  }
});
