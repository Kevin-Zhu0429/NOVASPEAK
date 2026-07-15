import test from "node:test";
import assert from "node:assert/strict";
import {
  bindNeteaseSession,
  getNeteaseAccount,
  getNeteasePlaylists,
  getNeteasePlaylistTracks,
  unbindNeteaseSession,
} from "./music-api.js";

// 测试全部使用假 Cookie 值

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json; charset=utf-8" },
    json: async () => body,
  };
}

function htmlResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "text/html" },
    json: async () => {
      throw new Error("not json");
    },
  };
}

function captureFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return typeof response === "function" ? response() : response;
  };
  return { calls, fetchImpl };
}

test("GET account：未绑定", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { bound: false })
  );
  const result = await getNeteaseAccount("http://api.test", { fetchImpl });
  assert.deepEqual(result, { bound: false });
  assert.equal(calls[0].url, "http://api.test/api/music/netease/account");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.credentials, "include");
});

test("GET account：已绑定返回公开账号信息", async () => {
  const account = {
    neteaseUserId: "123",
    nickname: "测试昵称",
    avatarUrl: "https://p1.music.126.net/a.jpg",
  };
  const { fetchImpl } = captureFetch(
    jsonResponse(200, { bound: true, account })
  );
  const result = await getNeteaseAccount("", { fetchImpl });
  assert.equal(result.bound, true);
  assert.deepEqual(result.account, account);
});

test("POST session：请求体只包含 cookies，且带 credentials include", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, {
      success: true,
      bound: true,
      account: { neteaseUserId: "9", nickname: "N", avatarUrl: null },
    })
  );
  const cookies = [
    { name: "MUSIC_U", value: "fake-token" },
    { name: "os", value: "pc" },
  ];
  const result = await bindNeteaseSession("http://api.test", cookies, {
    fetchImpl,
  });
  assert.equal(result.bound, true);

  const call = calls[0];
  assert.equal(call.url, "http://api.test/api/music/netease/session");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.credentials, "include");
  assert.equal(call.options.headers["Content-Type"], "application/json");

  const body = JSON.parse(call.options.body);
  // 只提交 cookies，不提交 userId 等任何身份字段
  assert.deepEqual(Object.keys(body), ["cookies"]);
  assert.deepEqual(body.cookies, cookies);
});

test("POST session：空 cookies 直接拒绝，不发请求", async () => {
  const { calls, fetchImpl } = captureFetch(jsonResponse(200, {}));
  for (const bad of [null, undefined, [], "MUSIC_U=x"]) {
    await assert.rejects(
      () => bindNeteaseSession("", bad, { fetchImpl }),
      /网易云登录信息无效/
    );
  }
  assert.equal(calls.length, 0);
});

test("DELETE session", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, bound: false, removed: true })
  );
  const result = await unbindNeteaseSession("http://api.test", { fetchImpl });
  assert.equal(result.removed, true);
  assert.equal(calls[0].url, "http://api.test/api/music/netease/session");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.credentials, "include");
});

test("JSON 错误映射：使用后端中文 error 和 code", async () => {
  const { fetchImpl } = captureFetch(
    jsonResponse(503, {
      error: "音乐功能尚未配置，请联系管理员",
      code: "MUSIC_NOT_CONFIGURED",
    })
  );
  await assert.rejects(
    () => getNeteaseAccount("", { fetchImpl }),
    (error) =>
      error.message === "音乐功能尚未配置，请联系管理员" &&
      error.code === "MUSIC_NOT_CONFIGURED" &&
      error.status === 503
  );
});

test("非 JSON 响应映射为稳定中文错误", async () => {
  const { fetchImpl } = captureFetch(htmlResponse(200));
  await assert.rejects(
    () => getNeteaseAccount("", { fetchImpl }),
    /查询网易云绑定状态失败/
  );
  const { fetchImpl: fetchImpl502 } = captureFetch(htmlResponse(502));
  await assert.rejects(
    () => unbindNeteaseSession("", { fetchImpl: fetchImpl502 }),
    /退出网易云账号失败/
  );
});

test("网络错误映射为稳定中文错误", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () => getNeteaseAccount("", { fetchImpl }),
    /网络连接失败/
  );
});

test("获取歌单：默认不带分页参数，带 credentials include", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { playlists: [], pagination: { limit: 30, offset: 0, more: false, total: null } })
  );
  const result = await getNeteasePlaylists("http://api.test", { fetchImpl });
  assert.deepEqual(result.playlists, []);
  assert.equal(calls[0].url, "http://api.test/api/music/netease/playlists");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.credentials, "include");
  // 不提交 uid / userId
  assert.ok(!calls[0].url.includes("uid"));
  assert.ok(!calls[0].url.includes("userId"));
});

test("获取歌单：自定义分页参数（加载更多）", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { playlists: [], pagination: {} })
  );
  await getNeteasePlaylists("", { limit: 50, offset: 90, fetchImpl });
  assert.equal(calls[0].url, "/api/music/netease/playlists?limit=50&offset=90");
});

test("获取歌曲列表：playlistId 路径编码", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { playlist: {}, tracks: [], pagination: {} })
  );
  await getNeteasePlaylistTracks("", "7044354223", {
    limit: 50,
    offset: 100,
    fetchImpl,
  });
  assert.equal(
    calls[0].url,
    "/api/music/netease/playlists/7044354223/tracks?limit=50&offset=100"
  );
  assert.equal(calls[0].options.credentials, "include");

  const { calls: encodedCalls, fetchImpl: encodedFetch } = captureFetch(
    jsonResponse(200, { playlist: {}, tracks: [], pagination: {} })
  );
  await getNeteasePlaylistTracks("", "1/2?x", { fetchImpl: encodedFetch });
  assert.equal(
    encodedCalls[0].url,
    "/api/music/netease/playlists/1%2F2%3Fx/tracks"
  );

  await assert.rejects(
    () => getNeteasePlaylistTracks("", "", { fetchImpl }),
    /歌单编号无效/
  );
});

test("AbortSignal 传递给 fetch，Abort 错误原样抛出", async () => {
  const controller = new AbortController();
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { playlists: [], pagination: {} })
  );
  await getNeteasePlaylists("", { signal: controller.signal, fetchImpl });
  assert.equal(calls[0].options.signal, controller.signal);

  const abortingFetch = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  await assert.rejects(
    () => getNeteasePlaylists("", { fetchImpl: abortingFetch }),
    (error) => error.name === "AbortError"
  );
});

test("歌单接口错误保留后端 code/status", async () => {
  const { fetchImpl } = captureFetch(
    jsonResponse(401, {
      error: "网易云登录已失效，请重新登录",
      code: "NETEASE_SESSION_INVALID",
    })
  );
  await assert.rejects(
    () => getNeteasePlaylists("", { fetchImpl }),
    (error) =>
      error.code === "NETEASE_SESSION_INVALID" && error.status === 401
  );

  const { fetchImpl: htmlFetch } = captureFetch(htmlResponse(200));
  await assert.rejects(
    () => getNeteasePlaylistTracks("", "123", { fetchImpl: htmlFetch }),
    /获取歌单歌曲失败/
  );
});

test("错误对象不包含提交的 Cookie 内容", async () => {
  const { fetchImpl } = captureFetch(
    jsonResponse(401, { error: "网易云登录已失效，请重新扫码登录" })
  );
  const secretValue = "super-secret-fake-music-u";
  try {
    await bindNeteaseSession(
      "",
      [{ name: "MUSIC_U", value: secretValue }],
      { fetchImpl }
    );
    assert.fail("应当抛出错误");
  } catch (error) {
    const dump = JSON.stringify({
      message: error.message,
      code: error.code,
      status: error.status,
      keys: Object.keys(error),
    });
    assert.ok(!dump.includes(secretValue));
    assert.ok(!dump.includes("cookies"));
  }
});
