import test from "node:test";
import assert from "node:assert/strict";
import {
  formatArtists,
  formatTrackCount,
  formatTrackDuration,
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
