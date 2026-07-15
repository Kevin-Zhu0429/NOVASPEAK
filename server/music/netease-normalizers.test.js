import test from "node:test";
import assert from "node:assert/strict";
import {
  getTrackAvailability,
  isValidPlaylistId,
  normalizePlaylist,
  normalizeTrack,
  parsePageParams,
  toIdString,
} from "./netease-normalizers.js";

test("toIdString：数字与字符串 ID 统一为十进制字符串", () => {
  assert.equal(toIdString(123456), "123456");
  assert.equal(toIdString("987654"), "987654");
  assert.equal(toIdString(" 42 "), "42");
  for (const bad of [null, undefined, "", "abc", "12a", -1.5, NaN, Infinity, {}]) {
    if (bad === -1.5) continue;
    assert.equal(toIdString(bad), null, String(bad));
  }
  // 数字截断为整数
  assert.equal(toIdString(7.9), "7");
});

test("isValidPlaylistId：只接受合理长度的十进制数字字符串", () => {
  assert.equal(isValidPlaylistId("7044354223"), true);
  assert.equal(isValidPlaylistId("1"), true);
  for (const bad of [
    "",
    "abc",
    "12a",
    "1".repeat(21),
    "-1",
    "1.5",
    "1e3",
    123,
    null,
    undefined,
    "../etc",
    "1%2F2",
  ]) {
    assert.equal(isValidPlaylistId(bad), false, String(bad));
  }
});

test("parsePageParams：默认值与合法范围", () => {
  assert.deepEqual(
    parsePageParams({}, { defaultLimit: 30, maxLimit: 50 }),
    { ok: true, limit: 30, offset: 0 }
  );
  assert.deepEqual(
    parsePageParams({ limit: "50", offset: "90" }, { defaultLimit: 30, maxLimit: 50 }),
    { ok: true, limit: 50, offset: 90 }
  );
});

test("parsePageParams：非法 limit/offset 被拒绝", () => {
  const options = { defaultLimit: 30, maxLimit: 50 };
  for (const bad of [
    { limit: "0" },
    { limit: "51" },
    { limit: "-1" },
    { limit: "abc" },
    { limit: "2.5" },
    { offset: "-1" },
    { offset: "abc" },
    { offset: "10001" },
    { offset: "1e3" },
  ]) {
    const result = parsePageParams(bad, options);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.ok(result.error);
  }
});

test("歌单标准化：字段完整、ID 为字符串", () => {
  const normalized = normalizePlaylist({
    id: 7044354223,
    name: "我喜欢的音乐",
    coverImgUrl: "https://p1.music.126.net/cover.jpg",
    trackCount: 100,
    playCount: 1234,
    subscribed: false,
    creator: { userId: 123, nickname: "创建者" },
    extraThirdPartyField: { huge: "object" },
  });
  assert.deepEqual(normalized, {
    id: "7044354223",
    name: "我喜欢的音乐",
    coverImgUrl: "https://p1.music.126.net/cover.jpg",
    trackCount: 100,
    playCount: 1234,
    subscribed: false,
    creator: { userId: "123", nickname: "创建者" },
  });
  // 不透传第三方原始字段
  assert.ok(!("extraThirdPartyField" in normalized));
});

test("歌单标准化：缺失字段有安全兜底", () => {
  const normalized = normalizePlaylist({ id: "1", coverImgUrl: "javascript:x" });
  assert.equal(normalized.name, "未命名歌单");
  assert.equal(normalized.coverImgUrl, null);
  assert.equal(normalized.trackCount, 0);
  assert.equal(normalized.playCount, null);
  assert.equal(normalized.subscribed, false);
  assert.equal(normalized.creator.userId, null);

  assert.equal(normalizePlaylist(null), null);
  assert.equal(normalizePlaylist({ name: "没有 id" }), null);
});

test("歌曲标准化：字段完整、ID 为字符串", () => {
  const normalized = normalizeTrack(
    {
      id: 987654,
      name: "歌曲名称",
      ar: [
        { id: 1, name: "歌手A" },
        { id: 2, name: "歌手B" },
      ],
      al: { id: 2, name: "专辑", picUrl: "https://p1.music.126.net/al.jpg" },
      dt: 240000,
      fee: 8,
    },
    { id: 987654, st: 0, pl: 320000 }
  );
  assert.deepEqual(normalized, {
    id: "987654",
    name: "歌曲名称",
    artists: [
      { id: "1", name: "歌手A" },
      { id: "2", name: "歌手B" },
    ],
    album: { id: "2", name: "专辑", picUrl: "https://p1.music.126.net/al.jpg" },
    durationMs: 240000,
    fee: 8,
    playable: true,
    unavailableReason: null,
  });
});

test("歌曲标准化：缺失歌手/专辑/时长有兜底", () => {
  const normalized = normalizeTrack({ id: "5" }, { id: "5", st: 0, pl: 128000 });
  assert.equal(normalized.name, "未知歌曲");
  assert.deepEqual(normalized.artists, []);
  assert.equal(normalized.album, null);
  assert.equal(normalized.durationMs, 0);
  assert.equal(normalized.fee, 0);

  assert.equal(normalizeTrack(null, null), null);
  assert.equal(normalizeTrack({ name: "没有 id" }, null), null);
});

test("可用性：privilege.st < 0 → 版权/地区不可用", () => {
  assert.deepEqual(getTrackAvailability({}, { st: -200, pl: 0 }), {
    playable: false,
    unavailableReason: "因版权或地区限制不可用",
  });
});

test("可用性：pl > 0 → 可播放；pl = 0 → 无播放权限", () => {
  assert.deepEqual(getTrackAvailability({}, { st: 0, pl: 320000 }), {
    playable: true,
    unavailableReason: null,
  });
  assert.deepEqual(getTrackAvailability({}, { st: 0, pl: 0 }), {
    playable: false,
    unavailableReason: "当前账号暂无播放权限",
  });
});

test("可用性：无 privilege 时不声称可播放", () => {
  assert.deepEqual(getTrackAvailability({ st: -1 }, null), {
    playable: false,
    unavailableReason: "因版权或地区限制不可用",
  });
  assert.deepEqual(
    getTrackAvailability({ noCopyrightRcmd: { type: 1 } }, undefined),
    { playable: false, unavailableReason: "因版权或地区限制不可用" }
  );
  assert.deepEqual(getTrackAvailability({}, undefined), {
    playable: false,
    unavailableReason: "歌曲可用性未知",
  });
});
