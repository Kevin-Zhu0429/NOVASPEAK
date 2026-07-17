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

function makeResponse({
  status = 206,
  headers = {},
  chunks = [new Uint8Array([1, 2, 3])],
  chunkDelayMs = 0,
  failAtChunk = null,
  failure = Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
  stallAtChunk = null,
} = {}) {
  let index = 0;
  let cancelled = false;
  let releaseStall = null;
  const body = new ReadableStream({
    async pull(controller) {
      if (failAtChunk !== null && index === failAtChunk) {
        controller.error(failure);
        return;
      }
      if (stallAtChunk !== null && index === stallAtChunk) {
        await new Promise((resolve) => {
          releaseStall = resolve;
        });
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      cancelled = true;
      releaseStall?.();
    },
  });
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders[name.toLowerCase()] ?? null },
    body,
    wasCancelled: () => cancelled,
  };
}

function parseRequestedRange(options) {
  const value = options?.headers?.Range ?? options?.headers?.range;
  const match = /^bytes=(\d+)-(\d+)$/.exec(value || "");
  assert.ok(match, `missing Range header: ${value}`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function createRangeServer(data, { requests = [], splitAt = null } = {}) {
  const source = Buffer.from(data);
  return async (url, options) => {
    const range = parseRequestedRange(options);
    requests.push({ url, options, ...range });
    const end = Math.min(range.end, source.length - 1);
    const block = source.subarray(range.start, end + 1);
    const chunks =
      splitAt && splitAt < block.length
        ? [block.subarray(0, splitAt), block.subarray(splitAt)]
        : [block];
    return makeResponse({
      headers: {
        "content-range": `bytes ${range.start}-${end}/${source.length}`,
        "content-length": block.length,
      },
      chunks: chunks.map((chunk) => new Uint8Array(chunk)),
    });
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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
    "https://example.com/music.126.net/a.mp3",
    "https://xmusic.163.com.evil.net/a.mp3",
    "https://xmusic.163.com/a.mp3",
  ]) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
});

test("IP、localhost、危险协议和带凭据 URL 拒绝", () => {
  for (const url of [
    "https://127.0.0.1/a.mp3",
    "https://[::1]/a.mp3",
    "https://localhost/a.mp3",
    "file:///etc/passwd",
    "data:audio/mp3;base64,AAAA",
    "ftp://music.126.net/a.mp3",
    "javascript:alert(1)",
    "https://user:pass@music.126.net/a.mp3",
    "not-a-url",
  ]) {
    assert.equal(isAllowedMediaUrl(url), false, url);
  }
});

test("安全日志辅助函数只返回 hostname", () => {
  assert.equal(
    mediaUrlHostname("https://m701.music.126.net/secret/path?token=x"),
    "m701.music.126.net"
  );
  assert.equal(mediaUrlHostname("bad"), "invalid-url");
});

test("单块 Range 下载携带 identity 编码且字节一致", async () => {
  const data = Buffer.from("0123456789");
  const requests = [];
  const stream = await openPlaybackStream(
    "https://m701.music.126.net/song.mp3?secret=hidden",
    {
      fetchImpl: createRangeServer(data, { requests }),
      blockBytes: 64,
    }
  );
  assert.ok((await collect(stream)).equals(data));
  assert.deepEqual(
    requests.map(({ start, end }) => [start, end]),
    [[0, 63]]
  );
  assert.equal(requests[0].options.headers["Accept-Encoding"], "identity");
  assert.equal(requests[0].options.redirect, "manual");
});

test("多块顺序拼接不丢字节、不重复字节", async () => {
  const data = Buffer.from(Array.from({ length: 257 }, (_, i) => i % 251));
  const requests = [];
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl: createRangeServer(data, { requests, splitAt: 17 }),
    blockBytes: 64,
  });
  assert.ok((await collect(stream)).equals(data));
  assert.deepEqual(
    requests.map(({ start, end }) => [start, end]),
    [
      [0, 63],
      [64, 127],
      [128, 191],
      [192, 255],
      [256, 319],
    ]
  );
});

test("下游长时间背压不会触发网络 stall 或额外请求", async () => {
  const data = Buffer.from(Array.from({ length: 96 }, (_, i) => i));
  const requests = [];
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl: createRangeServer(data, { requests }),
    blockBytes: 32,
    stallTimeoutMs: 10,
  });
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
    await delay(40);
  }
  assert.ok(Buffer.concat(chunks).equals(data));
  assert.equal(requests.length, 3);
});

test("合法重定向逐跳验证并保留同一 Range", async () => {
  const data = Buffer.from([7, 8, 9]);
  const requests = [];
  const redirect = makeResponse({
    status: 302,
    headers: { location: "https://m702.music.126.net/real.mp3" },
  });
  const rangeServer = createRangeServer(data, { requests });
  let first = true;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, ...parseRequestedRange(options) });
    if (first) {
      first = false;
      return redirect;
    }
    requests.pop();
    return rangeServer(url, options);
  };
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl,
    blockBytes: 16,
  });
  assert.deepEqual([...(await collect(stream))], [7, 8, 9]);
  assert.equal(redirect.wasCancelled(), true);
  assert.equal(requests[1].url, "https://m702.music.126.net/real.mp3");
  assert.equal(requests[0].options.headers.Range, requests[1].options.headers.Range);
});

test("重定向到非法域时拒绝且不向非法域发送 Range", async () => {
  const requests = [];
  const redirect = makeResponse({
    status: 302,
    headers: { location: "https://evil.example.com/a.mp3" },
  });
  const stream = await openPlaybackStream(
    "https://m701.music.126.net/a.mp3?token=secret",
    {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return redirect;
      },
      retryDelayMs: 0,
    }
  );
  await assert.rejects(
    () => collect(stream),
    (error) => error.code === MEDIA_ERROR.URL_REJECTED
  );
  assert.equal(requests.length, 1);
  assert.equal(redirect.wasCancelled(), true);
});

test("循环重定向超过限制时拒绝", async () => {
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl: async () =>
      makeResponse({
        status: 302,
        headers: { location: "https://m701.music.126.net/loop.mp3" },
      }),
  });
  await assert.rejects(
    () => collect(stream),
    (error) => error.code === MEDIA_ERROR.URL_REJECTED
  );
});

test("服务器忽略 Range 返回 200 时拒绝拼接并释放 body", async () => {
  const response = makeResponse({ status: 200 });
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl: async () => response,
  });
  await assert.rejects(
    () => collect(stream),
    (error) => error.code === MEDIA_ERROR.RANGE_UNSUPPORTED
  );
  assert.equal(response.wasCancelled(), true);
});

test("Content-Range 起点、终点或 Content-Length 不匹配时拒绝", async () => {
  const cases = [
    { "content-range": "bytes 1-3/4", "content-length": "3" },
    { "content-range": "bytes 0-2/4", "content-length": "3" },
    { "content-range": "bytes 0-3/4", "content-length": "2" },
  ];
  for (const headers of cases) {
    const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
      fetchImpl: async () =>
        makeResponse({ headers, chunks: [new Uint8Array([1, 2, 3, 4])] }),
      blockBytes: 4,
    });
    await assert.rejects(
      () => collect(stream),
      (error) => error.code === MEDIA_ERROR.RANGE_MISMATCH
    );
  }
});

test("服务端声明的总长度超过上限时在读取 body 前拒绝", async () => {
  const response = makeResponse({
    headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
    chunks: [new Uint8Array([1, 2, 3, 4])],
  });
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl: async () => response,
    blockBytes: 4,
    maxBytes: 64,
  });
  await assert.rejects(
    () => collect(stream),
    (error) => error.code === MEDIA_ERROR.TOO_LARGE
  );
  assert.equal(response.wasCancelled(), true);
});

test("块内连接中断时重试同一 Range，最终输出只出现一次", async () => {
  const data = Buffer.from(Array.from({ length: 80 }, (_, i) => i));
  const ranges = [];
  let calls = 0;
  const goodServer = createRangeServer(data);
  const fetchImpl = async (url, options) => {
    const range = parseRequestedRange(options);
    ranges.push([range.start, range.end]);
    calls += 1;
    if (calls === 1) {
      return makeResponse({
        headers: {
          "content-range": "bytes 0-39/80",
          "content-length": "40",
        },
        chunks: [new Uint8Array(data.subarray(0, 13))],
        failAtChunk: 1,
      });
    }
    return goodServer(url, options);
  };
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl,
    blockBytes: 40,
    retryDelayMs: 0,
  });
  assert.ok((await collect(stream)).equals(data));
  assert.deepEqual(ranges.slice(0, 2), [
    [0, 39],
    [0, 39],
  ]);
});

test("503 与 reader stall 可在块内恢复", async () => {
  const data = Buffer.from([1, 2, 3, 4]);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (calls === 1) return makeResponse({ status: 503 });
    if (calls === 2) {
      return makeResponse({
        headers: { "content-range": "bytes 0-3/4", "content-length": "4" },
        chunks: [new Uint8Array(data)],
        stallAtChunk: 0,
      });
    }
    return createRangeServer(data)(url, options);
  };
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl,
    blockBytes: 4,
    stallTimeoutMs: 15,
    maxBlockAttempts: 3,
    retryDelayMs: 0,
  });
  assert.ok((await collect(stream)).equals(data));
  assert.equal(calls, 3);
});

test("连续网络失败达到上限后返回安全诊断，不含 URL 和查询参数", async () => {
  const secretUrl = "https://m701.music.126.net/private/file.mp3?token=do-not-log";
  const fetchImpl = async () => {
    const cause = Object.assign(new Error("contains secret token"), {
      code: "UND_ERR_SOCKET",
    });
    throw new TypeError("fetch failed for secret URL", { cause });
  };
  const stream = await openPlaybackStream(secretUrl, {
    fetchImpl,
    maxBlockAttempts: 2,
    maxTotalRetries: 1,
    retryDelayMs: 0,
  });
  await assert.rejects(
    () => collect(stream),
    (error) => {
      assert.equal(error.code, MEDIA_ERROR.STREAM_INTERRUPTED);
      assert.equal(error.diagnostics.hostname, "m701.music.126.net");
      assert.equal(error.diagnostics.attemptCount, 2);
      const serialized = JSON.stringify(error.diagnostics);
      assert.equal(serialized.includes("do-not-log"), false);
      assert.equal(serialized.includes("/private/file.mp3"), false);
      assert.deepEqual(error.diagnostics.causeCodeChain, [
        MEDIA_ERROR.FETCH_FAILED,
        "TYPE_ERROR",
        "UND_ERR_SOCKET",
      ]);
      return true;
    }
  );
});

test("header timeout 会有限重试，耗尽后不无限循环", async () => {
  let calls = 0;
  const fetchImpl = (_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
      fetchImpl,
      headerTimeoutMs: 10,
      maxBlockAttempts: 2,
      retryDelayMs: 0,
    });
    await assert.rejects(
      () => collect(stream),
      (error) => error.code === MEDIA_ERROR.STREAM_INTERRUPTED
    );
    assert.equal(calls, 2);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("外部 Abort 会立即停止且不继续重试", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return makeResponse({
      headers: { "content-range": "bytes 0-3/4", "content-length": "4" },
      chunks: [new Uint8Array([1, 2, 3, 4])],
      stallAtChunk: 0,
    });
  };
  const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
    fetchImpl,
    signal: controller.signal,
    blockBytes: 4,
    stallTimeoutMs: 5_000,
    retryDelayMs: 0,
  });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(
    () => collect(stream),
    (error) => error.code === MEDIA_ERROR.ABORTED
  );
  await delay(5);
  assert.equal(calls, 1);
});

test("下游提前销毁流会取消正在进行的预取且无 unhandledRejection", async () => {
  let calls = 0;
  let prefetchedResponse = null;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const fetchImpl = async (_url, options) => {
      const { start } = parseRequestedRange(options);
      calls += 1;
      if (start === 0) {
        return makeResponse({
          headers: { "content-range": "bytes 0-3/8", "content-length": "4" },
          chunks: [new Uint8Array([1, 2, 3, 4])],
        });
      }
      prefetchedResponse = makeResponse({
        headers: { "content-range": "bytes 4-7/8", "content-length": "4" },
        chunks: [new Uint8Array([5, 6, 7, 8])],
        stallAtChunk: 0,
      });
      return prefetchedResponse;
    };
    const stream = await openPlaybackStream("https://m701.music.126.net/a.mp3", {
      fetchImpl,
      blockBytes: 4,
      stallTimeoutMs: 5_000,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.deepEqual([...first.value], [1, 2, 3, 4]);
    await delay(5);
    assert.equal(calls, 2);
    const closed = new Promise((resolve) => stream.once("close", resolve));
    stream.destroy();
    await closed;
    await iterator.return();
    await delay(10);
    assert.equal(prefetchedResponse.wasCancelled(), true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("byte-limit Transform 只计数，不把慢消费者误判为 stall", async () => {
  const limiter = createByteLimitTransform({
    maxBytes: 1024,
    // 兼容旧调用参数，但此参数不再创建下游 stall timer
    stallTimeoutMs: 5,
  });
  limiter.write(Buffer.alloc(400, 1));
  await delay(20);
  limiter.end(Buffer.alloc(400, 2));
  assert.equal((await collect(limiter)).length, 800);

  const tooSmall = createByteLimitTransform({ maxBytes: 3 });
  tooSmall.end(Buffer.from([1, 2, 3, 4]));
  await assert.rejects(
    () => collect(tooSmall),
    (error) => error.code === MEDIA_ERROR.TOO_LARGE
  );
});
