import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { migrateNeteaseAccounts } from "./migrate.js";
import { encryptMusicCredential } from "./credential-store.js";
import { saveNeteaseBinding } from "./account-service.js";
import {
  NETEASE_ERROR,
  NeteaseError,
  createNeteaseClient,
} from "./netease-client.js";
import { createNeteaseMusicRouter } from "./routes.js";

// 全部使用 in-memory 数据库和 mock 网易云客户端，
// 不访问真实网络、真实账号或 server/data/novaspeak.db

process.env.MUSIC_CREDENTIAL_KEY ||= crypto.randomBytes(32).toString("base64");

const COOKIE_A = "MUSIC_U=fake-cookie-user-a; os=pc";
const COOKIE_B = "MUSIC_U=fake-cookie-user-b; os=pc";

const db = new Database(":memory:");
migrateNeteaseAccounts(db);

function seed(principalKey, cookie, neteaseUserId, expiresAt = null) {
  saveNeteaseBinding(db, {
    principalKey,
    encrypted: encryptMusicCredential(cookie, process.env),
    profile: { neteaseUserId, nickname: `昵称-${principalKey}`, avatarUrl: null },
    credentialExpiresAt: expiresAt,
  });
}

seed("user-a", COOKIE_A, "111");
seed("user-b", COOKIE_B, "222");
seed("guest:expired-library", "MUSIC_U=expired-guest-cookie", "333",
  new Date(Date.now() - 1000).toISOString());

// ---------- mock 网易云客户端 ----------

function makePlaylist(id, { subscribed = false, creatorId = "111", trackCount = 3 } = {}) {
  return {
    id: Number(id),
    name: `歌单${id}`,
    coverImgUrl: "https://p1.music.126.net/cover.jpg",
    trackCount,
    playCount: 10,
    subscribed,
    creator: { userId: Number(creatorId), nickname: "创建者" },
  };
}

function createMockClient(overrides = {}) {
  const calls = { playlists: [], tracks: [] };
  const client = {
    calls,
    async listUserPlaylists(params) {
      calls.playlists.push(params);
      if (overrides.playlistsError) throw overrides.playlistsError;
      const pages = overrides.playlistPages?.[params.neteaseUserId] || [[], false];
      const pageIndex = Math.floor(params.offset / params.limit);
      const page = pages[pageIndex] || { playlists: [], more: false };
      return page;
    },
    async listPlaylistTracks(params) {
      calls.tracks.push(params);
      if (overrides.tracksError) throw overrides.tracksError;
      return (
        overrides.tracksResult || {
          songs: [
            {
              id: 987654,
              name: "测试歌曲",
              ar: [{ id: 1, name: "歌手" }],
              al: { id: 2, name: "专辑", picUrl: "https://p1.music.126.net/a.jpg" },
              dt: 240000,
              fee: 0,
            },
          ],
          privileges: [{ id: 987654, st: 0, pl: 320000 }],
        }
      );
    },
    async verifySession() {
      throw new Error("本测试不应调用 verifySession");
    },
  };
  return client;
}

// ---------- 测试服务器 ----------

const authState = { user: { id: "user-a", isGuest: false } };

function createApp(mockClient) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/music/netease",
    createNeteaseMusicRouter({
      db,
      neteaseClient: mockClient,
      requireAuthenticated: (req, res, next) => {
        if (!authState.user) return res.status(401).json({ error: "请先登录" });
        req.authUser = authState.user;
        next();
      },
    })
  );
  return app;
}

async function withApp(mockClient, run) {
  const app = createApp(mockClient);
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(async (path) => {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    authState.user = { id: "user-a", isGuest: false };
  }
}

const defaultPages = {
  111: [
    {
      playlists: [
        makePlaylist(100, { subscribed: false, creatorId: "111", trackCount: 3 }),
        makePlaylist(200, { subscribed: true, creatorId: "999" }),
      ],
      more: false,
    },
  ],
  222: [
    { playlists: [makePlaylist(300, { creatorId: "222" })], more: false },
  ],
};

// ---------- 凭据与身份 ----------

test("解密后的 Cookie 与数据库中的网易云 uid 被传入客户端", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const result = await api("/api/music/netease/playlists");
    assert.equal(result.status, 200);
    assert.equal(mock.calls.playlists.length, 1);
    assert.equal(mock.calls.playlists[0].cookie, COOKIE_A);
    assert.equal(mock.calls.playlists[0].neteaseUserId, "111");
  });
});

test("A/B 用户 Cookie 与 uid 完全隔离", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    await api("/api/music/netease/playlists");
    authState.user = { id: "user-b", isGuest: false };
    await api("/api/music/netease/playlists");

    assert.equal(mock.calls.playlists[0].cookie, COOKIE_A);
    assert.equal(mock.calls.playlists[0].neteaseUserId, "111");
    assert.equal(mock.calls.playlists[1].cookie, COOKIE_B);
    assert.equal(mock.calls.playlists[1].neteaseUserId, "222");
  });
});

test("前端传入 uid 不改变后端使用的网易云 uid", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const result = await api(
      "/api/music/netease/playlists?uid=99999&userId=other&limit=30"
    );
    assert.equal(result.status, 200);
    assert.equal(mock.calls.playlists[0].neteaseUserId, "111");
  });
});

test("响应不含 Cookie、密文、IV、authTag", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const playlists = await api("/api/music/netease/playlists");
    const tracks = await api("/api/music/netease/playlists/100/tracks");
    for (const result of [playlists, tracks]) {
      assert.ok(!result.text.includes("fake-cookie-user-a"));
      assert.ok(!result.text.includes("MUSIC_U"));
      for (const key of ["ciphertext", "encrypted_cookie", "cookie_iv", "cookie_auth_tag", "authTag"]) {
        assert.ok(!result.text.includes(key), key);
      }
    }
  });
});

test("未绑定用户返回 409 NETEASE_ACCOUNT_NOT_BOUND", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    authState.user = { id: "user-unbound", isGuest: false };
    const result = await api("/api/music/netease/playlists");
    assert.equal(result.status, 409);
    assert.equal(result.json.code, "NETEASE_ACCOUNT_NOT_BOUND");
    assert.equal(result.json.error, "请先绑定网易云账号");
    assert.equal(mock.calls.playlists.length, 0);
  });
});

test("凭据解密失败返回安全错误，不透出 crypto 细节，不删除绑定", async () => {
  seed("user-corrupt", "MUSIC_U=will-corrupt", "444");
  const flip = (value) => {
    const buffer = Buffer.from(value, "base64");
    buffer[0] ^= 0xff;
    return buffer.toString("base64");
  };
  db.prepare(
    "UPDATE netease_accounts SET cookie_auth_tag = ? WHERE principal_key = 'user-corrupt'"
  ).run(
    flip(
      db
        .prepare("SELECT cookie_auth_tag FROM netease_accounts WHERE principal_key = 'user-corrupt'")
        .get().cookie_auth_tag
    )
  );

  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    authState.user = { id: "user-corrupt", isGuest: false };
    const result = await api("/api/music/netease/playlists");
    assert.equal(result.status, 401);
    assert.equal(result.json.code, "NETEASE_CREDENTIAL_UNREADABLE");
    assert.ok(!/unable to authenticate|gcm|decipher/i.test(result.text));
    // 绑定记录未被自动删除
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM netease_accounts WHERE principal_key = 'user-corrupt'")
      .get();
    assert.equal(row.count, 1);
  });
});

test("过期 guest 凭据不可读取（按未绑定处理）", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    authState.user = { id: "guest:expired-library", isGuest: true };
    const result = await api("/api/music/netease/playlists");
    assert.equal(result.status, 409);
    assert.equal(result.json.code, "NETEASE_ACCOUNT_NOT_BOUND");
  });
});

// ---------- 分页与参数 ----------

test("歌单分页默认 limit=30 offset=0，歌曲默认 limit=50", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const playlists = await api("/api/music/netease/playlists");
    assert.equal(mock.calls.playlists[0].limit, 30);
    assert.equal(mock.calls.playlists[0].offset, 0);
    assert.deepEqual(playlists.json.pagination, {
      limit: 30,
      offset: 0,
      more: false,
      total: null,
    });

    await api("/api/music/netease/playlists/100/tracks");
    assert.equal(mock.calls.tracks[0].limit, 50);
    assert.equal(mock.calls.tracks[0].offset, 0);
  });
});

test("非法 limit/offset 返回 400", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    for (const query of [
      "limit=0",
      "limit=51",
      "limit=abc",
      "offset=-1",
      "offset=99999999",
    ]) {
      const result = await api(`/api/music/netease/playlists?${query}`);
      assert.equal(result.status, 400, query);
      assert.equal(result.json.code, "INVALID_PAGINATION");
    }
    const tracksResult = await api(
      "/api/music/netease/playlists/100/tracks?limit=101"
    );
    assert.equal(tracksResult.status, 400);
    assert.equal(mock.calls.playlists.length, 0);
  });
});

test("非法 playlistId 返回 400", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    for (const bad of ["abc", "1x", "1".repeat(21)]) {
      const result = await api(`/api/music/netease/playlists/${bad}/tracks`);
      assert.equal(result.status, 400, bad);
      assert.equal(result.json.code, "INVALID_PLAYLIST_ID");
    }
    // 路径穿越编码被 Express 解码后路由不匹配，同样到不了处理器
    const traversal = await api("/api/music/netease/playlists/%2e%2e/tracks");
    assert.ok([400, 404].includes(traversal.status));
    assert.equal(mock.calls.tracks.length, 0);
    assert.equal(mock.calls.playlists.length, 0);
  });
});

// ---------- 歌单标准化与归属 ----------

test("歌单响应字段标准化，ID 为字符串", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const result = await api("/api/music/netease/playlists");
    const playlist = result.json.playlists[0];
    assert.deepEqual(playlist, {
      id: "100",
      name: "歌单100",
      coverImgUrl: "https://p1.music.126.net/cover.jpg",
      trackCount: 3,
      playCount: 10,
      subscribed: false,
      creator: { userId: "111", nickname: "创建者" },
    });
    assert.equal(result.json.playlists[1].subscribed, true);
  });
});

test("自建歌单和收藏歌单都可访问，歌曲字段标准化", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    for (const playlistId of ["100", "200"]) {
      const result = await api(
        `/api/music/netease/playlists/${playlistId}/tracks`
      );
      assert.equal(result.status, 200, playlistId);
      assert.equal(result.json.playlist.id, playlistId);
      const track = result.json.tracks[0];
      assert.deepEqual(track, {
        id: "987654",
        name: "测试歌曲",
        artists: [{ id: "1", name: "歌手" }],
        album: { id: "2", name: "专辑", picUrl: "https://p1.music.126.net/a.jpg" },
        durationMs: 240000,
        fee: 0,
        playable: true,
        unavailableReason: null,
      });
    }
    // 归属验证会把 playlistId 原样传给歌曲接口
    assert.equal(mock.calls.tracks[0].playlistId, "100");
  });
});

test("非本人可见歌单返回 404，且不调用歌曲接口", async () => {
  const mock = createMockClient({ playlistPages: defaultPages });
  await withApp(mock, async (api) => {
    const result = await api("/api/music/netease/playlists/99999/tracks");
    assert.equal(result.status, 404);
    assert.equal(result.json.code, "NETEASE_PLAYLIST_NOT_FOUND");
    assert.equal(result.json.error, "未找到该歌单");
    assert.equal(mock.calls.tracks.length, 0);
  });
});

test("空歌单返回空 tracks 与 more:false", async () => {
  const pages = {
    111: [
      {
        playlists: [makePlaylist(500, { trackCount: 0 })],
        more: false,
      },
    ],
  };
  const mock = createMockClient({
    playlistPages: pages,
    tracksResult: { songs: [], privileges: [] },
  });
  await withApp(mock, async (api) => {
    const result = await api("/api/music/netease/playlists/500/tracks");
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.tracks, []);
    assert.deepEqual(result.json.pagination, {
      limit: 50,
      offset: 0,
      more: false,
      total: 0,
    });
  });
});

test("归属验证支持多页扫描，遇 more:false 停止", async () => {
  const pages = {
    111: [
      { playlists: [makePlaylist(1, {})], more: true },
      { playlists: [makePlaylist(2, {}), makePlaylist(777, { trackCount: 60 })], more: false },
    ],
  };
  const mock = createMockClient({ playlistPages: pages });
  await withApp(mock, async (api) => {
    const result = await api("/api/music/netease/playlists/777/tracks");
    assert.equal(result.status, 200);
    assert.equal(result.json.playlist.id, "777");
    // 扫描调用：offset 0 → offset 100
    assert.equal(mock.calls.playlists.length, 2);
    assert.equal(mock.calls.playlists[0].offset, 0);
    assert.equal(mock.calls.playlists[0].limit, 100);
    assert.equal(mock.calls.playlists[1].offset, 100);
    // more:true 时 pagination 计算基于 trackCount
    assert.equal(result.json.pagination.total, 60);
    assert.equal(result.json.pagination.more, true);
  });
});

// ---------- 上游错误映射 ----------

test("SESSION_INVALID / RATE_LIMITED / REQUEST_FAILED 分别映射 401/429/502", async () => {
  const cases = [
    [NETEASE_ERROR.SESSION_INVALID, 401],
    [NETEASE_ERROR.RATE_LIMITED, 429],
    [NETEASE_ERROR.REQUEST_FAILED, 502],
  ];
  for (const [code, expectedStatus] of cases) {
    const mock = createMockClient({
      playlistsError: new NeteaseError(code, "上游测试错误"),
    });
    await withApp(mock, async (api) => {
      const result = await api("/api/music/netease/playlists");
      assert.equal(result.status, expectedStatus, code);
      assert.equal(result.json.code, code);
    });
  }
});

// ---------- netease-client 封装（注入 mock 底层 API）----------

test("netease-client：user_playlist / playlist_track_all 被正确封装", async () => {
  const apiCalls = [];
  const client = createNeteaseClient({
    api: {
      user_playlist: async (params) => {
        apiCalls.push(["user_playlist", params]);
        return {
          status: 200,
          body: { code: 200, more: true, playlist: [makePlaylist(1, {})] },
        };
      },
      playlist_track_all: async (params) => {
        apiCalls.push(["playlist_track_all", params]);
        return {
          status: 200,
          body: { code: 200, songs: [{ id: 9 }], privileges: [{ id: 9 }] },
        };
      },
    },
  });

  const playlists = await client.listUserPlaylists({
    neteaseUserId: "111",
    cookie: "MUSIC_U=fake",
    limit: 30,
    offset: 60,
  });
  assert.equal(playlists.more, true);
  assert.equal(playlists.playlists.length, 1);
  assert.deepEqual(apiCalls[0], [
    "user_playlist",
    { uid: "111", limit: 30, offset: 60, cookie: "MUSIC_U=fake" },
  ]);

  const tracks = await client.listPlaylistTracks({
    playlistId: "777",
    cookie: "MUSIC_U=fake",
    limit: 50,
    offset: 100,
  });
  assert.equal(tracks.songs.length, 1);
  assert.equal(tracks.privileges.length, 1);
  assert.deepEqual(apiCalls[1], [
    "playlist_track_all",
    { id: "777", limit: 50, offset: 100, cookie: "MUSIC_U=fake" },
  ]);
});

test("netease-client：上游 reject 与异常结构映射为稳定错误", async () => {
  const rejecting = createNeteaseClient({
    api: {
      user_playlist: async () => {
        const answer = { status: 301, body: { code: 301 } };
        throw answer;
      },
      playlist_track_all: async () => ({
        status: 200,
        body: { code: 200, songs: "not-an-array" },
      }),
    },
  });

  await assert.rejects(
    () =>
      rejecting.listUserPlaylists({
        neteaseUserId: "111",
        cookie: "MUSIC_U=fake",
      }),
    (error) => error.code === NETEASE_ERROR.SESSION_INVALID
  );

  await assert.rejects(
    () =>
      rejecting.listPlaylistTracks({ playlistId: "1", cookie: "MUSIC_U=fake" }),
    (error) =>
      error.code === NETEASE_ERROR.REQUEST_FAILED &&
      !error.message.includes("MUSIC_U")
  );

  await assert.rejects(
    () => rejecting.listUserPlaylists({ neteaseUserId: "111", cookie: "" }),
    (error) => error.code === NETEASE_ERROR.SESSION_INVALID
  );
});
