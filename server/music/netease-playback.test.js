import test from "node:test";
import assert from "node:assert/strict";
import {
  NETEASE_PLAYBACK_ERROR,
  createNeteaseClient,
} from "./netease-client.js";

// 全部 mock，绝不访问真实网易云

function v1Response(entry) {
  return { status: 200, body: { code: 200, data: [entry] } };
}

function goodEntry(overrides = {}) {
  return {
    id: 9000,
    url: "https://m701.music.126.net/fake/audio.mp3",
    br: 128000,
    code: 200,
    freeTrialInfo: null,
    ...overrides,
  };
}

test("song_url_v1 standard：正常返回完整 URL", async () => {
  const calls = [];
  const client = createNeteaseClient({
    api: {
      song_url_v1: async (params) => {
        calls.push(params);
        return v1Response(goodEntry());
      },
      song_url: async () => {
        throw new Error("正常路径不应调用旧接口");
      },
    },
  });

  const result = await client.getSongPlaybackUrl({
    songId: "9000",
    cookie: "MUSIC_U=fake-a",
  });
  assert.equal(result.url, "https://m701.music.126.net/fake/audio.mp3");
  assert.deepEqual(calls[0], {
    id: "9000",
    level: "standard",
    cookie: "MUSIC_U=fake-a",
  });
});

test("v1 方法不存在时降级 song_url br=128000", async () => {
  const calls = [];
  const client = createNeteaseClient({
    api: {
      song_url: async (params) => {
        calls.push(params);
        return v1Response(goodEntry());
      },
    },
  });
  const result = await client.getSongPlaybackUrl({
    songId: "9000",
    cookie: "MUSIC_U=fake",
  });
  assert.ok(result.url);
  assert.deepEqual(calls[0], { id: "9000", br: 128000, cookie: "MUSIC_U=fake" });
});

test("v1 兼容性异常（库内部错误）后降级 song_url", async () => {
  const client = createNeteaseClient({
    api: {
      song_url_v1: async () => {
        throw new TypeError("Cannot read properties of undefined");
      },
      song_url: async () => v1Response(goodEntry()),
    },
  });
  const result = await client.getSongPlaybackUrl({
    songId: "9000",
    cookie: "MUSIC_U=fake",
  });
  assert.ok(result.url);
});

test("v1 响应结构无效时降级 song_url", async () => {
  const client = createNeteaseClient({
    api: {
      song_url_v1: async () => ({ status: 200, body: { code: 200, data: "bad" } }),
      song_url: async () => v1Response(goodEntry()),
    },
  });
  const result = await client.getSongPlaybackUrl({
    songId: "9000",
    cookie: "MUSIC_U=fake",
  });
  assert.ok(result.url);
});

test("明确无权限（单曲 code≠200 / URL 空）不 fallback 绕过", async () => {
  let fallbackCalled = false;
  const noPermission = createNeteaseClient({
    api: {
      song_url_v1: async () => v1Response(goodEntry({ code: -110, url: null })),
      song_url: async () => {
        fallbackCalled = true;
        return v1Response(goodEntry());
      },
    },
  });
  await assert.rejects(
    () => noPermission.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.URL_UNAVAILABLE
  );
  assert.equal(fallbackCalled, false);

  const emptyUrl = createNeteaseClient({
    api: {
      song_url_v1: async () => v1Response(goodEntry({ url: "" })),
      song_url: async () => {
        fallbackCalled = true;
        return v1Response(goodEntry());
      },
    },
  });
  await assert.rejects(
    () => emptyUrl.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.URL_UNAVAILABLE
  );
  assert.equal(fallbackCalled, false);
});

test("freeTrialInfo 非空拒绝试听，不 fallback", async () => {
  let fallbackCalled = false;
  const client = createNeteaseClient({
    api: {
      song_url_v1: async () =>
        v1Response(goodEntry({ freeTrialInfo: { start: 30, end: 60 } })),
      song_url: async () => {
        fallbackCalled = true;
        return v1Response(goodEntry());
      },
    },
  });
  await assert.rejects(
    () => client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.TRIAL_ONLY
  );
  assert.equal(fallbackCalled, false);
});

test("登录失效（301/401）映射 PLAYBACK_SESSION_INVALID，不 fallback", async () => {
  for (const status of [301, 401]) {
    let fallbackCalled = false;
    const client = createNeteaseClient({
      api: {
        song_url_v1: async () => {
          throw { status, body: { code: status } };
        },
        song_url: async () => {
          fallbackCalled = true;
          return v1Response(goodEntry());
        },
      },
    });
    await assert.rejects(
      () => client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
      (error) => error.code === NETEASE_PLAYBACK_ERROR.SESSION_INVALID
    );
    assert.equal(fallbackCalled, false, String(status));
  }
});

test("429 映射 PLAYBACK_RATE_LIMITED，不 fallback", async () => {
  let fallbackCalled = false;
  const client = createNeteaseClient({
    api: {
      song_url_v1: async () => {
        throw { status: 429, body: { code: 429 } };
      },
      song_url: async () => {
        fallbackCalled = true;
        return v1Response(goodEntry());
      },
    },
  });
  await assert.rejects(
    () => client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.RATE_LIMITED
  );
  assert.equal(fallbackCalled, false);
});

test("A/B Cookie 隔离：调用参数使用各自的 Cookie", async () => {
  const cookiesSeen = [];
  const client = createNeteaseClient({
    api: {
      song_url_v1: async (params) => {
        cookiesSeen.push(params.cookie);
        return v1Response(goodEntry());
      },
    },
  });
  await client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=user-a" });
  await client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=user-b" });
  assert.deepEqual(cookiesSeen, ["MUSIC_U=user-a", "MUSIC_U=user-b"]);
});

test("错误对象不含 Cookie、URL 或第三方完整响应", async () => {
  const client = createNeteaseClient({
    api: {
      song_url_v1: async () => {
        throw {
          status: 502,
          body: { code: 502, secretPayload: "should-not-leak" },
        };
      },
    },
  });
  try {
    await client.getSongPlaybackUrl({
      songId: "9000",
      cookie: "MUSIC_U=super-secret-cookie",
    });
    assert.fail("应当抛出");
  } catch (error) {
    assert.equal(error.code, NETEASE_PLAYBACK_ERROR.REQUEST_FAILED);
    const dump = JSON.stringify({ message: error.message, ...error });
    assert.ok(!dump.includes("super-secret-cookie"));
    assert.ok(!dump.includes("should-not-leak"));
    assert.ok(!dump.includes("MUSIC_U"));
  }
});

test("空 Cookie 与非法 songId 直接拒绝", async () => {
  const client = createNeteaseClient({
    api: { song_url_v1: async () => v1Response(goodEntry()) },
  });
  await assert.rejects(
    () => client.getSongPlaybackUrl({ songId: "9000", cookie: "" }),
    (error) => error.code === "NETEASE_SESSION_INVALID"
  );
  await assert.rejects(
    () => client.getSongPlaybackUrl({ songId: "abc", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.RESPONSE_INVALID
  );
});

test("旧接口降级后仍执行全部单曲校验（试听照样拒绝）", async () => {
  const client = createNeteaseClient({
    api: {
      song_url: async () =>
        v1Response(goodEntry({ freeTrialInfo: { start: 0, end: 30 } })),
    },
  });
  await assert.rejects(
    () => client.getSongPlaybackUrl({ songId: "9000", cookie: "MUSIC_U=x" }),
    (error) => error.code === NETEASE_PLAYBACK_ERROR.TRIAL_ONLY
  );
});
