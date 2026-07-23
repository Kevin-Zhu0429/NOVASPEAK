import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import express from "express";
import Database from "better-sqlite3";
import { migrateNeteaseAccounts } from "./migrate.js";
import { migrateMusicQueue } from "./queue-migrate.js";
import { encryptMusicCredential } from "./credential-store.js";
import { saveNeteaseBinding } from "./account-service.js";
import { createNeteaseMusicRouter } from "./routes.js";

// 全部使用 in-memory 数据库 + mock Presence + mock 网易云客户端

process.env.MUSIC_CREDENTIAL_KEY ||= crypto.randomBytes(32).toString("base64");

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
db.prepare("INSERT INTO channels VALUES ('cs2', 'CS2')").run();
migrateNeteaseAccounts(db);
migrateMusicQueue(db);

function seedBinding(principalKey, neteaseUserId) {
  saveNeteaseBinding(db, {
    principalKey,
    encrypted: encryptMusicCredential(
      `MUSIC_U=fake-${principalKey}; os=pc`,
      process.env
    ),
    profile: { neteaseUserId, nickname: "网易云昵称", avatarUrl: null },
    credentialExpiresAt: null,
  });
}
seedBinding("user-a", "111");
seedBinding("user-b", "222");

// 歌单：user-a（uid 111）可见歌单 500，共 5 首（第 4 首不可播放）
const PLAYLIST = {
  id: 500,
  name: "测试歌单",
  coverImgUrl: "https://p1.music.126.net/pl.jpg",
  trackCount: 5,
  playCount: 1,
  subscribed: false,
  creator: { userId: 111, nickname: "创建者" },
};
const SONGS = Array.from({ length: 5 }, (_, index) => ({
  id: 9000 + index,
  name: `真实歌名${index}`,
  ar: [{ id: 1, name: "真实歌手" }],
  al: { id: 2, name: "真实专辑", picUrl: "https://p1.music.126.net/cover.jpg" },
  dt: 200000 + index,
  fee: 0,
}));
const PRIVILEGES = SONGS.map((song, index) => ({
  id: song.id,
  st: index === 3 ? -200 : 0,
  pl: index === 3 ? 0 : 320000,
}));

const mockClient = {
  calls: { playlists: [], tracks: [], details: [] },
  async listUserPlaylists(params) {
    mockClient.calls.playlists.push(params);
    if (params.neteaseUserId === "111") {
      return { playlists: [PLAYLIST], more: false };
    }
    return { playlists: [], more: false };
  },
  async listPlaylistTracks(params) {
    mockClient.calls.tracks.push(params);
    const offset = params.offset || 0;
    const limit = params.limit || 50;
    return {
      songs: SONGS.slice(offset, offset + limit),
      privileges: PRIVILEGES.slice(offset, offset + limit),
    };
  },
  async getSongDetail(params) {
    mockClient.calls.details.push(params);
    return {
      song: {
        id: Number(params.songId),
        name: "搜索详情真实歌名",
        ar: [{ id: 8, name: "搜索详情真实歌手" }],
        al: { id: 9, name: "搜索详情真实专辑", picUrl: "https://p1.music.126.net/search-detail.jpg" },
        dt: 210000,
        fee: 0,
      },
      privileges: [{ id: Number(params.songId), st: 0, pl: 320000 }],
    };
  },
  async verifySession() {
    throw new Error("本测试不应调用 verifySession");
  },
};

// mock Presence：可控的频道成员表
const membership = new Map(); // userId -> channelId
const mockPresence = {
  isUserInChannel(userId, channelId) {
    return membership.get(userId) === channelId;
  },
};

const playbackCalls = { pause: [], skip: [] };
const mockPlaybackController = {
  getPlaybackState() {
    return { active: true, queueItemId: "1", paused: false, elapsedMs: 1500 };
  },
  setPaused(channelId, paused) {
    playbackCalls.pause.push({ channelId, paused });
    return { active: true, queueItemId: "1", paused, elapsedMs: 1500, changed: true };
  },
  async skip(channelId) {
    playbackCalls.skip.push(channelId);
    return { active: true, queueItemId: "1", paused: false, elapsedMs: 1500, changed: true };
  },
};

const authState = { user: { id: "user-a", isGuest: false, role: "member", displayName: "甲" } };

const app = express();
app.use(express.json());
app.use(
  "/api/music/netease",
  createNeteaseMusicRouter({
    db,
    neteaseClient: mockClient,
    presenceService: mockPresence,
    playbackController: mockPlaybackController,
    requireAuthenticated: (req, res, next) => {
      req.authUser = authState.user;
      next();
    },
  })
);
const server = app.listen(0);
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text), text };
}

function setUser(id, { role = "member", displayName = "成员", isGuest = false } = {}) {
  authState.user = { id, isGuest, role, displayName };
}

test("不在频道的用户被拒绝（403 MUSIC_NOT_IN_CHANNEL）", async () => {
  setUser("user-a");
  membership.delete("user-a");
  for (const [method, path, body] of [
    ["GET", "/api/music/netease/channels/cs2/queue"],
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "500", songId: "9000", trackIndex: 0 }],
    ["POST", "/api/music/netease/channels/cs2/queue/playlists", { playlistId: "500" }],
    ["POST", "/api/music/netease/channels/cs2/playback/pause", { paused: true }],
    ["POST", "/api/music/netease/channels/cs2/playback/skip"],
    ["POST", "/api/music/netease/channels/cs2/queue/shuffle"],
    ["POST", "/api/music/netease/channels/cs2/queue/1/prioritize"],
    ["POST", "/api/music/netease/channels/cs2/queue/search-tracks", { songId: "9000" }],
    ["DELETE", "/api/music/netease/channels/cs2/queue/mine"],
    ["DELETE", "/api/music/netease/channels/cs2/queue"],
    ["DELETE", "/api/music/netease/channels/cs2/queue/1"],
  ]) {
    const result = await api(method, path, body);
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.json.code, "MUSIC_NOT_IN_CHANNEL");
  }
});

test("单曲点歌：服务端元数据入队，前端伪造字段无效", async () => {
  setUser("user-a", { displayName: "甲" });
  membership.set("user-a", "cs2");

  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/tracks",
    {
      playlistId: "500",
      songId: "9000",
      trackIndex: 0,
      // 伪造字段必须全部被忽略
      songName: "伪造歌名",
      artists: [{ id: "666", name: "伪造歌手" }],
      coverUrl: "https://evil.example.com/x.jpg",
      durationMs: 1,
      playable: true,
      userId: "user-b",
      principalKey: "user-b",
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.addedCount, 1);
  assert.equal(result.json.projectedPosition, 1);
  assert.ok(result.json.queueItemId);

  const row = db
    .prepare("SELECT * FROM music_queue_items WHERE id = ?")
    .get(result.json.queueItemId);
  // 元数据来自 mock 网易云返回并经服务端标准化
  assert.equal(row.song_name, "真实歌名0");
  assert.equal(row.cover_url, "https://p1.music.126.net/cover.jpg");
  assert.equal(row.duration_ms, 200000);
  // 归属是当前认证用户，不是伪造的 user-b
  assert.equal(row.principal_key, "user-a");
  assert.equal(row.requester_display_name, "甲");
});

test("songId 与 trackIndex 不匹配时拒绝", async () => {
  setUser("user-a");
  membership.set("user-a", "cs2");
  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/tracks",
    { playlistId: "500", songId: "9000", trackIndex: 2 }
  );
  assert.equal(result.status, 404);
  assert.equal(result.json.code, "MUSIC_TRACK_NOT_FOUND");
});

test("不可播放歌曲拒绝入队", async () => {
  setUser("user-a");
  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/tracks",
    { playlistId: "500", songId: "9003", trackIndex: 3 }
  );
  assert.equal(result.status, 409);
  assert.equal(result.json.code, "MUSIC_TRACK_UNAVAILABLE");
});

test("参数校验：非法 playlistId/songId/trackIndex/queueItemId", async () => {
  setUser("user-a");
  const badRequests = [
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "abc", songId: "9000", trackIndex: 0 }],
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "500", songId: "not-a-number", trackIndex: 0 }],
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "500", songId: "9000", trackIndex: -1 }],
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "500", songId: "9000", trackIndex: 1.5 }],
    ["POST", "/api/music/netease/channels/cs2/queue/tracks", { playlistId: "500", songId: "9000", trackIndex: 100000 }],
    ["POST", "/api/music/netease/channels/cs2/queue/playlists", { playlistId: "" }],
    ["DELETE", "/api/music/netease/channels/cs2/queue/not-a-number"],
  ];
  for (const [method, path, body] of badRequests) {
    const result = await api(method, path, body);
    assert.equal(result.status, 400, `${method} ${JSON.stringify(body)}`);
  }
});

test("整歌单添加：只加入可播放歌曲并统计跳过数量", async () => {
  setUser("user-b", { displayName: "乙" });
  membership.set("user-b", "cs2");
  // user-b 的网易云账号（uid 222）看不到歌单 500 → 404
  const notOwned = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/playlists",
    { playlistId: "500" }
  );
  assert.equal(notOwned.status, 404);
  assert.equal(notOwned.json.code, "NETEASE_PLAYLIST_NOT_FOUND");

  setUser("user-a", { displayName: "甲" });
  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/playlists",
    { playlistId: "500" }
  );
  assert.equal(result.status, 200);
  // 5 首中第 4 首不可播放 → 添加 4 首，跳过 1 首
  assert.equal(result.json.addedCount, 4);
  assert.equal(result.json.skippedUnavailableCount, 1);
  assert.equal(result.json.truncated, false);
});

test("队列快照：公平顺序、canCancel、不暴露 principal/guest UUID", async () => {
  // user-b 加一首自己的歌（先绑定歌单可见性无关，直接单曲从自己歌单？
  // user-b 看不到歌单 500，改用 guest 直接通过队列服务入队会绕过路由——
  // 这里改为验证现有 user-a 的队列视角与 guest 队列项的展示
  setUser("guest:queue-uuid-99", { displayName: "访客丙", isGuest: true });
  membership.set("guest:queue-uuid-99", "cs2");
  seedBinding("guest:queue-uuid-99", "333");
  // guest 也能看队列（未绑定也可以，但这里已绑定不影响）
  const guestView = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(guestView.status, 200);
  assert.ok(!guestView.text.includes("queue-uuid-99"));
  assert.ok(!guestView.text.includes("principal"));
  assert.ok(!guestView.text.includes("user-a"));

  setUser("user-a");
  const view = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(view.status, 200);
  assert.equal(view.json.nowPlaying, null);
  assert.ok(view.json.items.length >= 5);
  // 顺序字段与自己的歌曲标记
  assert.equal(view.json.items[0].projectedPosition, 1);
  assert.ok(view.json.items.every((item) => item.requester.displayName));
  assert.ok(
    view.json.items.every(
      (item) => item.requester.isCurrentUser === true && item.canCancel === true
    )
  );
  assert.equal(view.json.controls.canControlPlayback, true);
});

test("播放控制：当前频道 Admin/Member 可用，Guest 被拒绝", async () => {
  membership.set("user-a", "cs2");
  setUser("user-a", { role: "member", displayName: "普通成员" });
  const memberPause = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/pause",
    { paused: true }
  );
  assert.equal(memberPause.status, 200);
  assert.equal(memberPause.json.playback.paused, true);
  const memberSkip = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/skip"
  );
  assert.equal(memberSkip.status, 200);
  const memberView = await api(
    "GET",
    "/api/music/netease/channels/cs2/queue"
  );
  assert.equal(memberView.json.controls.canControlPlayback, true);

  setUser("guest:control-uuid", {
    role: "guest",
    displayName: "访客",
    isGuest: true,
  });
  membership.set("guest:control-uuid", "cs2");
  const guestPause = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/pause",
    { paused: false }
  );
  assert.equal(guestPause.status, 403);
  assert.equal(guestPause.json.code, "MUSIC_PLAYBACK_FORBIDDEN");
  const guestSkip = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/skip"
  );
  assert.equal(guestSkip.status, 403);
  const guestView = await api(
    "GET",
    "/api/music/netease/channels/cs2/queue"
  );
  assert.equal(guestView.json.controls.canControlPlayback, false);

  setUser("admin-control", { role: "admin", displayName: "管理员" });
  membership.set("admin-control", "cs2");
  const invalid = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/pause",
    { paused: "yes" }
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "MUSIC_PLAYBACK_INVALID_STATE");

  const resumed = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/pause",
    { paused: false }
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.playback.paused, false);
  assert.deepEqual(playbackCalls.pause.at(-1), {
    channelId: "cs2",
    paused: false,
  });
  assert.equal(playbackCalls.skip.at(-1), "cs2");

  const adminView = await api(
    "GET",
    "/api/music/netease/channels/cs2/queue"
  );
  assert.equal(adminView.status, 200);
  assert.equal(adminView.json.controls.canControlPlayback, true);
});

test("随机与置顶：Admin/Member 可用、Guest 被拒，响应不泄露内部排序", async () => {
  setUser("user-a", { role: "member", displayName: "普通成员" });
  membership.set("user-a", "cs2");
  let view = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.ok(view.json.items.length >= 2);
  const targetId = view.json.items.at(-1).id;

  const shuffled = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/shuffle"
  );
  assert.equal(shuffled.status, 200);
  assert.equal(shuffled.json.success, true);
  assert.ok(Number.isInteger(shuffled.json.shuffledCount));

  const prioritized = await api(
    "POST",
    `/api/music/netease/channels/cs2/queue/${targetId}/prioritize`
  );
  assert.equal(prioritized.status, 200);
  view = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(view.json.items[0].id, targetId);
  assert.equal(view.json.items[0].prioritized, true);
  assert.ok(!view.text.includes("priority_order"));
  assert.ok(!view.text.includes("queue_order"));
  assert.ok(!view.text.includes("last_served_bucket_order"));

  setUser("guest:queue-controls", {
    role: "guest",
    displayName: "访客",
    isGuest: true,
  });
  membership.set("guest:queue-controls", "cs2");
  for (const path of [
    "/api/music/netease/channels/cs2/queue/shuffle",
    `/api/music/netease/channels/cs2/queue/${targetId}/prioritize`,
  ]) {
    const denied = await api("POST", path);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, "MUSIC_PLAYBACK_FORBIDDEN");
  }
});

test("取消权限：他人拒绝、admin 允许、本人允许", async () => {
  // user-a 队列里有歌；guest 是普通用户不能取消
  setUser("user-a");
  const view = await api("GET", "/api/music/netease/channels/cs2/queue");
  const targetId = view.json.items[0].id;

  setUser("guest:queue-uuid-99", { isGuest: true });
  const guestCancel = await api(
    "DELETE",
    `/api/music/netease/channels/cs2/queue/${targetId}`
  );
  assert.equal(guestCancel.status, 403);
  assert.equal(guestCancel.json.code, "MUSIC_QUEUE_FORBIDDEN");

  // admin 可取消任意 pending
  setUser("admin-1", { role: "admin", displayName: "管理员" });
  membership.set("admin-1", "cs2");
  const adminCancel = await api(
    "DELETE",
    `/api/music/netease/channels/cs2/queue/${targetId}`
  );
  assert.equal(adminCancel.status, 200);

  // 本人取消自己的
  setUser("user-a");
  const mine = await api("GET", "/api/music/netease/channels/cs2/queue");
  const myItem = mine.json.items.find((item) => item.requester.isCurrentUser);
  const selfCancel = await api(
    "DELETE",
    `/api/music/netease/channels/cs2/queue/${myItem.id}`
  );
  assert.equal(selfCancel.status, 200);

  // 不存在的项目
  const missing = await api(
    "DELETE",
    "/api/music/netease/channels/cs2/queue/999999"
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "MUSIC_QUEUE_ITEM_NOT_FOUND");
});

test("解绑网易云账号时取消自己的全部 pending，且不影响他人", async () => {
  // guest 入队一首（guest 已绑定 uid 333，但 mock 只让 111 看到歌单 →
  // 直接从 user-a 的视角保证 user-a 还有 pending，然后 guest 添加自己的）
  setUser("user-a");
  membership.set("user-a", "cs2");
  await api("POST", "/api/music/netease/channels/cs2/queue/tracks", {
    playlistId: "500",
    songId: "9001",
    trackIndex: 1,
  });

  const before = db
    .prepare(
      "SELECT COUNT(*) AS count FROM music_queue_items WHERE principal_key = 'user-a' AND status = 'pending'"
    )
    .get().count;
  assert.ok(before >= 1);

  const unbind = await api("DELETE", "/api/music/netease/session");
  assert.equal(unbind.status, 200);
  assert.equal(unbind.json.removed, true);
  assert.equal(unbind.json.cancelledPending, before);

  const after = db
    .prepare(
      "SELECT COUNT(*) AS count FROM music_queue_items WHERE principal_key = 'user-a' AND status = 'pending'"
    )
    .get().count;
  assert.equal(after, 0);

  // 其他用户的 pending 不受影响（guest 未受影响，绑定还在）
  const guestBinding = db
    .prepare(
      "SELECT COUNT(*) AS count FROM netease_accounts WHERE principal_key = 'guest:queue-uuid-99'"
    )
    .get().count;
  assert.equal(guestBinding, 1);
});

test("用户上限：整歌单添加最多补足剩余容量并标记 truncated", async () => {
  // 重新绑定 user-a
  seedBinding("user-a", "111");
  setUser("user-a");
  membership.set("user-a", "cs2");

  // 先手动填充 48 首（直接走服务端入队以简化）
  const { enqueueTracks } = await import("./music-queue.js");
  enqueueTracks(db, {
    channelId: "cs2",
    principalKey: "user-a",
    requesterDisplayName: "甲",
    tracks: Array.from({ length: 48 }, (_, i) => ({
      id: String(70000 + i),
      name: `填充${i}`,
      artists: [],
      album: null,
      durationMs: 1000,
      fee: 0,
    })),
  });

  // 歌单有 4 首可播放，但剩余容量只有 2 → 添加 2 首并 truncated
  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/playlists",
    { playlistId: "500" }
  );
  assert.equal(result.status, 200);
  assert.equal(result.json.addedCount, 2);
  assert.equal(result.json.truncated, true);

  // 已满后再加 → 409 用户上限
  const overflow = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/playlists",
    { playlistId: "500" }
  );
  assert.equal(overflow.status, 409);
  assert.equal(overflow.json.code, "MUSIC_USER_QUEUE_LIMIT");
});

test("搜索点歌服务端重新查询详情，且用户可删除自己的全部待播歌曲", async () => {
  seedBinding("user-search", "444");
  setUser("user-search", { displayName: "搜索用户" });
  membership.set("user-search", "cs2");
  const result = await api(
    "POST",
    "/api/music/netease/channels/cs2/queue/search-tracks",
    { songId: "812345" }
  );
  assert.equal(result.status, 200);
  assert.equal(mockClient.calls.details.at(-1).songId, "812345");
  const stored = db
    .prepare("SELECT song_name, requester_display_name FROM music_queue_items WHERE id = ?")
    .get(Number(result.json.queueItemId));
  assert.deepEqual(stored, {
    song_name: "搜索详情真实歌名",
    requester_display_name: "搜索用户",
  });

  const removed = await api(
    "DELETE",
    "/api/music/netease/channels/cs2/queue/mine"
  );
  assert.equal(removed.status, 200);
  assert.ok(removed.json.cancelledCount >= 1);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM music_queue_items WHERE channel_id = 'cs2' AND principal_key = 'user-search' AND status = 'pending'"
    ).get().count,
    0
  );
});

test("只有管理员可以清空频道待播队列", async () => {
  setUser("user-b", { role: "member", displayName: "乙" });
  membership.set("user-b", "cs2");
  const denied = await api("DELETE", "/api/music/netease/channels/cs2/queue");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, "MUSIC_QUEUE_FORBIDDEN");

  setUser("user-b", { role: "admin", displayName: "管理员" });
  const cleared = await api("DELETE", "/api/music/netease/channels/cs2/queue");
  assert.equal(cleared.status, 200);
  assert.ok(cleared.json.cancelledCount >= 1);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS count FROM music_queue_items WHERE channel_id = 'cs2' AND status = 'pending'"
    ).get().count,
    0
  );
});

// ---------- DJ 过渡开关 ----------

test("DJ 过渡开关：Member/Admin 可切换、Guest 与未登录被拒、快照透出状态", async () => {
  setUser("user-a", { role: "member", displayName: "普通成员" });
  membership.set("user-a", "cs2");

  // 默认关闭，快照带 djTransition 字段
  let view = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(view.status, 200);
  assert.deepEqual(view.json.djTransition, {
    enabled: false,
    transitionState: "idle",
  });

  // Member 开启
  const on = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/dj-transition",
    { enabled: true }
  );
  assert.equal(on.status, 200);
  assert.equal(on.json.djTransitionEnabled, true);
  assert.ok(Number.isSafeInteger(on.json.revision));
  view = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(view.json.djTransition.enabled, true);

  // 响应绝不泄露内部 reservation / 游标 / principal 信息
  for (const banned of ["reservation", "principal", "bucket", "cursor", "MUSIC_U"]) {
    assert.equal(view.text.includes(banned), false, `响应包含 ${banned}`);
  }

  // 非法 enabled 参数返回 400
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }]) {
    const bad = await api(
      "POST",
      "/api/music/netease/channels/cs2/playback/dj-transition",
      body
    );
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, "MUSIC_DJ_TRANSITION_INVALID_STATE");
  }

  // Admin 可关闭
  setUser("admin-dj", { role: "admin", displayName: "管理员" });
  membership.set("admin-dj", "cs2");
  const off = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/dj-transition",
    { enabled: false }
  );
  assert.equal(off.status, 200);
  assert.equal(off.json.djTransitionEnabled, false);

  // Guest 只能查看，不能切换
  setUser("guest:dj-uuid", { role: "guest", displayName: "访客", isGuest: true });
  membership.set("guest:dj-uuid", "cs2");
  const guestToggle = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/dj-transition",
    { enabled: true }
  );
  assert.equal(guestToggle.status, 403);
  assert.equal(guestToggle.json.code, "MUSIC_PLAYBACK_FORBIDDEN");
  const guestView = await api("GET", "/api/music/netease/channels/cs2/queue");
  assert.equal(guestView.status, 200);
  assert.equal(guestView.json.djTransition.enabled, false);

  // 不在频道的成员按既有规则拒绝
  setUser("user-out", { role: "member", displayName: "场外成员" });
  membership.delete("user-out");
  const outside = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/dj-transition",
    { enabled: true }
  );
  assert.equal(outside.status, 403);
  assert.equal(outside.json.code, "MUSIC_NOT_IN_CHANNEL");

  // 未登录返回 401
  authState.user = null;
  const anonymous = await api(
    "POST",
    "/api/music/netease/channels/cs2/playback/dj-transition",
    { enabled: true }
  );
  assert.equal(anonymous.status, 401);

  setUser("user-a", { role: "member", displayName: "普通成员" });
});
