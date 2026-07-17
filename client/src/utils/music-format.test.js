import test from "node:test";
import assert from "node:assert/strict";
import {
  formatArtists,
  formatTrackCount,
  formatTrackDuration,
  getPlaybackProgress,
} from "./music-format.js";

test("时长格式化：0 毫秒", () => {
  assert.equal(formatTrackDuration(0), "00:00");
});

test("时长格式化：普通 mm:ss", () => {
  assert.equal(formatTrackDuration(240000), "04:00");
  assert.equal(formatTrackDuration(191500), "03:11");
  assert.equal(formatTrackDuration(59999), "00:59");
});

test("时长格式化：超过 1 小时为 h:mm:ss", () => {
  assert.equal(formatTrackDuration(3600000), "1:00:00");
  assert.equal(formatTrackDuration(3723000), "1:02:03");
  assert.equal(formatTrackDuration(7325000), "2:02:05");
});

test("时长格式化：非法输入返回占位", () => {
  for (const bad of [-1, NaN, Infinity, "240000", null, undefined, {}]) {
    assert.equal(formatTrackDuration(bad), "--:--", String(bad));
  }
});

test("多歌手拼接", () => {
  assert.equal(
    formatArtists([{ name: "歌手A" }, { name: "歌手B" }]),
    "歌手A、歌手B"
  );
  assert.equal(formatArtists([{ name: " 单歌手 " }]), "单歌手");
});

test("缺失歌手时返回未知歌手", () => {
  for (const bad of [[], null, undefined, [{ name: "" }], [{}]]) {
    assert.equal(formatArtists(bad), "未知歌手");
  }
});

test("歌曲数量文案", () => {
  assert.equal(formatTrackCount(100), "100 首");
  assert.equal(formatTrackCount(0), "0 首");
  for (const bad of [-1, NaN, null, undefined, "3"]) {
    assert.equal(formatTrackCount(bad), "", String(bad));
  }
});

test("播放进度：按快照后的本地时间推进并限制在歌曲时长内", () => {
  const progressing = getPlaybackProgress(
    { elapsedMs: 30_000, durationMs: 180_000 },
    1_000,
    3_500
  );
  assert.equal(progressing.elapsedMs, 32_500);
  assert.equal(progressing.durationMs, 180_000);
  assert.ok(Math.abs(progressing.percent - (32_500 / 180_000) * 100) < 1e-9);
  assert.deepEqual(
    getPlaybackProgress(
      { elapsedMs: 179_000, durationMs: 180_000 },
      1_000,
      5_000
    ),
    { elapsedMs: 180_000, durationMs: 180_000, percent: 100 }
  );
});

test("播放进度：无效数据安全归零", () => {
  assert.deepEqual(getPlaybackProgress(null, NaN, NaN), {
    elapsedMs: 0,
    durationMs: 0,
    percent: 0,
  });
});

test("播放进度：暂停期间不按本地时钟继续增长", () => {
  assert.deepEqual(
    getPlaybackProgress(
      { elapsedMs: 45_000, durationMs: 180_000, paused: true },
      1_000,
      31_000
    ),
    { elapsedMs: 45_000, durationMs: 180_000, percent: 25 }
  );
});
