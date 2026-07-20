import test from "node:test";
import assert from "node:assert/strict";
import { RELEASE_NOTES, WEB_APP_VERSION } from "./release-notes.js";

test("当前网页版本与第一条更新日志一致", () => {
  assert.equal(WEB_APP_VERSION, "3.0.1");
  assert.equal(RELEASE_NOTES[0].version, WEB_APP_VERSION);
});

test("小更新不要求 OTA，大版本明确要求桌面更新", () => {
  assert.equal(RELEASE_NOTES[0].requiresDesktopUpdate, false);
  assert.equal(RELEASE_NOTES.find((release) => release.version === "3.0.0")?.requiresDesktopUpdate, true);
});

test("更新日志版本唯一且每个版本都有可展示内容", () => {
  const versions = RELEASE_NOTES.map((release) => release.version);
  assert.equal(new Set(versions).size, versions.length);
  for (const release of RELEASE_NOTES) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.ok(release.title);
    assert.ok(release.changes.length > 0);
    assert.ok(release.changes.every((change) => typeof change === "string" && change.trim()));
  }
});
