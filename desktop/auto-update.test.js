const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  safeUpdateError,
  safeUpdateVersion,
  shouldEnableAutoUpdates,
  startAutoUpdates,
  UPDATE_FEED_URL,
} = require("./auto-update");

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFixture({ dialogResponses = [] } = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { updater.checkCalls += 1; };
  updater.setFeedURL = (value) => { updater.feedConfig = value; };
  updater.downloadUpdate = async () => { updater.downloadCalls += 1; };
  updater.quitAndInstall = (...args) => { updater.installCalls.push(args); };
  updater.checkCalls = 0;
  updater.downloadCalls = 0;
  updater.installCalls = [];
  const scheduled = { timeouts: [], intervals: [] };
  const timers = {
    setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; scheduled.timeouts.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
    setInterval(fn, delay) { const timer = { fn, delay, unref() {} }; scheduled.intervals.push(timer); return timer; },
    clearInterval(timer) { timer.cleared = true; },
  };
  const progress = [];
  const win = { isDestroyed: () => false, setProgressBar: (value) => progress.push(value) };
  const dialog = {
    calls: [],
    async showMessageBox(...args) {
      this.calls.push(args.at(-1));
      return { response: dialogResponses.shift() ?? 1 };
    },
  };
  const logs = [];
  const controller = startAutoUpdates({
    app: { isPackaged: true },
    dialog,
    getMainWindow: () => win,
    updaterFactory: () => updater,
    logger: { error: (...args) => logs.push(args) },
    env: {},
    platform: "win32",
    timers,
  });
  return { controller, dialog, logs, progress, scheduled, updater };
}

test("auto updates only run for installed packaged Windows builds", () => {
  assert.equal(shouldEnableAutoUpdates({ isPackaged: true, platform: "win32", env: {} }), true);
  assert.equal(shouldEnableAutoUpdates({ isPackaged: false, platform: "win32", env: {} }), false);
  assert.equal(shouldEnableAutoUpdates({ isPackaged: true, platform: "linux", env: {} }), false);
  assert.equal(shouldEnableAutoUpdates({ isPackaged: true, platform: "win32", env: { PORTABLE_EXECUTABLE_FILE: "NovaSpeak.exe" } }), false);
});

test("versions and errors are reduced to safe display fields", () => {
  assert.equal(safeUpdateVersion({ version: "0.2.1-beta.1" }), "0.2.1-beta.1");
  assert.equal(safeUpdateVersion({ version: "https://secret.example/update" }), "新版本");
  assert.deepEqual(safeUpdateError({ name: "HTTPError", code: "ERR_UPDATER", message: "https://secret.example/file" }), {
    name: "HTTPError",
    code: "ERR_UPDATER",
  });
});

test("scheduled startup check does not overlap and stop clears timers", async () => {
  const fixture = createFixture();
  assert.equal(fixture.controller.enabled, true);
  assert.deepEqual(fixture.updater.feedConfig, { provider: "generic", url: UPDATE_FEED_URL });
  assert.equal(fixture.scheduled.timeouts.length, 1);
  assert.equal(fixture.scheduled.intervals.length, 1);
  await fixture.scheduled.timeouts[0].fn();
  assert.equal(fixture.updater.checkCalls, 1);
  fixture.controller.stop();
  assert.equal(fixture.scheduled.timeouts[0].cleared, true);
  assert.equal(fixture.scheduled.intervals[0].cleared, true);
});

test("accepted update downloads and installs after explicit restart choice", async () => {
  const fixture = createFixture({ dialogResponses: [0, 0] });
  fixture.updater.emit("update-available", { version: "0.2.0" });
  await flushAsync();
  assert.equal(fixture.updater.downloadCalls, 1);
  fixture.updater.emit("download-progress", { percent: 37 });
  assert.equal(fixture.progress.at(-1), 0.37);
  fixture.updater.emit("update-downloaded", { version: "0.2.0" });
  await flushAsync();
  assert.deepEqual(fixture.updater.installCalls, [[false, true]]);
  fixture.controller.stop();
});

test("declining an available update does not start a download", async () => {
  const fixture = createFixture({ dialogResponses: [1] });
  fixture.updater.emit("update-available", { version: "0.2.0" });
  await flushAsync();
  assert.equal(fixture.updater.downloadCalls, 0);
  fixture.controller.stop();
});

test("updater errors never log a download URL or raw message", () => {
  const fixture = createFixture();
  fixture.updater.emit("error", {
    name: "Error",
    code: "ERR_UPDATER",
    message: "https://voice.novagaming.top/desktop-updates/private.exe",
  });
  const serialized = JSON.stringify(fixture.logs);
  assert.match(serialized, /ERR_UPDATER/);
  assert.doesNotMatch(serialized, /private\.exe|desktop-updates/);
  fixture.controller.stop();
});
