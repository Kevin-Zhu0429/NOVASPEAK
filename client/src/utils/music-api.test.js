import test from "node:test";
import assert from "node:assert/strict";
import {
  bindNeteaseSession,
  cancelOwnPendingMusicQueue,
  cancelMusicQueueItem,
  clearChannelMusicQueue,
  enqueueNeteasePlaylist,
  enqueueNeteaseSearchTrack,
  enqueueNeteaseTrack,
  getChannelMusicQueue,
  getNeteaseAccount,
  getNeteasePlaylists,
  getNeteasePlaylistTracks,
  prioritizeChannelMusicQueueItem,
  searchNeteaseTracks,
  setChannelDjTransition,
  setChannelMusicPaused,
  shuffleChannelMusicQueue,
  skipChannelMusicTrack,
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

test("获取频道队列：路径编码 + credentials + AbortSignal", async () => {
  const controller = new AbortController();
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { channelId: "cs2", nowPlaying: null, items: [], totalPending: 0, revision: 1 })
  );
  const result = await getChannelMusicQueue("http://api.test", "cs2", {
    signal: controller.signal,
    fetchImpl,
  });
  assert.equal(result.channelId, "cs2");
  assert.equal(calls[0].url, "http://api.test/api/music/netease/channels/cs2/queue");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.signal, controller.signal);

  const { calls: encodedCalls, fetchImpl: encodedFetch } = captureFetch(
    jsonResponse(200, { items: [] })
  );
  await getChannelMusicQueue("", "频道/1?x", { fetchImpl: encodedFetch });
  assert.equal(
    encodedCalls[0].url,
    "/api/music/netease/channels/%E9%A2%91%E9%81%93%2F1%3Fx/queue"
  );

  await assert.rejects(() => getChannelMusicQueue("", "", { fetchImpl }), /频道无效/);
});

test("管理员播放控制：暂停/继续与下一首使用固定频道路由", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, playback: { paused: true, elapsedMs: 1234 } })
  );
  const paused = await setChannelMusicPaused(
    "http://api.test",
    "频道/1",
    true,
    { fetchImpl }
  );
  assert.equal(paused.playback.paused, true);
  assert.equal(
    calls[0].url,
    "http://api.test/api/music/netease/channels/%E9%A2%91%E9%81%93%2F1/playback/pause"
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { paused: true });

  await skipChannelMusicTrack("", "cs2", { fetchImpl });
  assert.equal(
    calls[1].url,
    "/api/music/netease/channels/cs2/playback/skip"
  );
  assert.equal(calls[1].options.method, "POST");

  await assert.rejects(
    () => setChannelMusicPaused("", "cs2", "yes", { fetchImpl }),
    /暂停状态无效/
  );
});

test("队列随机与优先播放使用固定 POST 路由", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, revision: 8 })
  );
  await shuffleChannelMusicQueue("http://api.test", "频道/1", { fetchImpl });
  await prioritizeChannelMusicQueueItem(
    "http://api.test",
    "频道/1",
    "42",
    { fetchImpl }
  );
  assert.equal(
    calls[0].url,
    "http://api.test/api/music/netease/channels/%E9%A2%91%E9%81%93%2F1/queue/shuffle"
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[1].url,
    "http://api.test/api/music/netease/channels/%E9%A2%91%E9%81%93%2F1/queue/42/prioritize"
  );
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.credentials, "include");

  await assert.rejects(
    () => prioritizeChannelMusicQueueItem("", "cs2", "", { fetchImpl }),
    /队列项无效/
  );
});

test("单曲点歌：请求体只含 playlistId/songId/trackIndex", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, addedCount: 1, queueItemId: "5", projectedPosition: 2, revision: 3 })
  );
  const result = await enqueueNeteaseTrack(
    "http://api.test",
    "cs2",
    { playlistId: "500", songId: "9000", trackIndex: 7 },
    { fetchImpl }
  );
  assert.equal(result.queueItemId, "5");

  const call = calls[0];
  assert.equal(call.url, "http://api.test/api/music/netease/channels/cs2/queue/tracks");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.credentials, "include");
  const body = JSON.parse(call.options.body);
  // 不提交 userId / principalKey / 歌曲展示元数据
  assert.deepEqual(Object.keys(body).sort(), ["playlistId", "songId", "trackIndex"]);
  assert.deepEqual(body, { playlistId: "500", songId: "9000", trackIndex: 7 });
});

test("整歌单添加：请求体只含 playlistId", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, addedCount: 10, skippedUnavailableCount: 2, truncated: false, revision: 4 })
  );
  const result = await enqueueNeteasePlaylist(
    "",
    "cs2",
    { playlistId: "500" },
    { fetchImpl }
  );
  assert.equal(result.addedCount, 10);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body), ["playlistId"]);
  assert.equal(
    calls[0].url,
    "/api/music/netease/channels/cs2/queue/playlists"
  );
});

test("取消队列项：DELETE + 路径编码", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, revision: 5 })
  );
  await cancelMusicQueueItem("", "cs2", "123", { fetchImpl });
  assert.equal(calls[0].url, "/api/music/netease/channels/cs2/queue/123");
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.credentials, "include");

  await assert.rejects(
    () => cancelMusicQueueItem("", "cs2", "", { fetchImpl }),
    /队列项无效/
  );
});

test("搜索歌曲：关键词与分页参数正确编码", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { tracks: [], pagination: { more: false } })
  );
  await searchNeteaseTracks("http://api.test", "周 杰伦", {
    limit: 30,
    offset: 60,
    fetchImpl,
  });
  assert.equal(
    calls[0].url,
    "http://api.test/api/music/netease/search/tracks?keywords=%E5%91%A8+%E6%9D%B0%E4%BC%A6&limit=30&offset=60"
  );
  assert.equal(calls[0].options.method, "GET");
  await assert.rejects(
    () => searchNeteaseTracks("", "   ", { fetchImpl }),
    /请输入歌曲或歌手名称/
  );
});

test("搜索结果点歌只提交 songId", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, queueItemId: "7" })
  );
  await enqueueNeteaseSearchTrack("", "cs2", { songId: "123" }, { fetchImpl });
  assert.equal(calls[0].url, "/api/music/netease/channels/cs2/queue/search-tracks");
  assert.deepEqual(JSON.parse(calls[0].options.body), { songId: "123" });
});

test("批量删除自己的排队歌曲与管理员清空队列使用独立 DELETE 路由", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, cancelledCount: 2, revision: 8 })
  );
  await cancelOwnPendingMusicQueue("", "cs2", { fetchImpl });
  await clearChannelMusicQueue("", "cs2", { fetchImpl });
  assert.deepEqual(
    calls.map((call) => [call.url, call.options.method]),
    [
      ["/api/music/netease/channels/cs2/queue/mine", "DELETE"],
      ["/api/music/netease/channels/cs2/queue", "DELETE"],
    ]
  );
});

test("队列接口错误保留后端 code/status", async () => {
  const { fetchImpl } = captureFetch(
    jsonResponse(403, {
      error: "请先进入该语音频道",
      code: "MUSIC_NOT_IN_CHANNEL",
    })
  );
  await assert.rejects(
    () => getChannelMusicQueue("", "cs2", { fetchImpl }),
    (error) => error.code === "MUSIC_NOT_IN_CHANNEL" && error.status === 403
  );

  const { fetchImpl: limitFetch } = captureFetch(
    jsonResponse(409, {
      error: "每人最多同时排队 50 首歌曲",
      code: "MUSIC_USER_QUEUE_LIMIT",
    })
  );
  await assert.rejects(
    () =>
      enqueueNeteaseTrack("", "cs2", { playlistId: "1", songId: "2", trackIndex: 0 }, { fetchImpl: limitFetch }),
    (error) => error.code === "MUSIC_USER_QUEUE_LIMIT"
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

test("DJ 过渡开关：固定频道路由与参数校验", async () => {
  const { calls, fetchImpl } = captureFetch(
    jsonResponse(200, { success: true, djTransitionEnabled: true, revision: 7 })
  );
  const result = await setChannelDjTransition(
    "http://api.test",
    "频道/1",
    true,
    { fetchImpl }
  );
  assert.equal(result.djTransitionEnabled, true);
  assert.equal(
    calls[0].url,
    "http://api.test/api/music/netease/channels/%E9%A2%91%E9%81%93%2F1/playback/dj-transition"
  );
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { enabled: true });

  await setChannelDjTransition("", "cs2", false, { fetchImpl });
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false });

  await assert.rejects(
    () => setChannelDjTransition("", "cs2", "yes", { fetchImpl }),
    /DJ 过渡状态无效/
  );
  await assert.rejects(
    () => setChannelDjTransition("", "", true, { fetchImpl }),
    /频道无效/
  );
});
