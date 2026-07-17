const assert = require("node:assert/strict");
const test = require("node:test");
const { getPublishOrder, isUpdateAsset } = require("./publish-local-update");

test("local update publisher only copies NSIS updater assets", () => {
  assert.equal(isUpdateAsset("latest.yml"), true);
  assert.equal(isUpdateAsset("NovaSpeak-0.2.0-x64-Setup.exe"), true);
  assert.equal(isUpdateAsset("NovaSpeak-0.2.0-x64-Setup.exe.blockmap"), true);
  assert.equal(isUpdateAsset("NovaSpeak-0.2.0-x64-Portable.exe"), false);
  assert.equal(isUpdateAsset("server.env"), false);
});

test("manifest is published last so clients never see incomplete assets", () => {
  assert.deepEqual(getPublishOrder([
    "latest.yml",
    "NovaSpeak-0.2.0-x64-Setup.exe",
    "NovaSpeak-0.2.0-x64-Setup.exe.blockmap",
  ]), [
    "NovaSpeak-0.2.0-x64-Setup.exe",
    "NovaSpeak-0.2.0-x64-Setup.exe.blockmap",
    "latest.yml",
  ]);
});
