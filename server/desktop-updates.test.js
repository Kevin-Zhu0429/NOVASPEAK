import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  isAllowedDesktopUpdateAsset,
  resolveDesktopUpdateDirectory,
  setDesktopUpdateResponseHeaders,
} from "./desktop-updates.js";

test("desktop update directory defaults under server data and accepts an explicit override", () => {
  const serverDirectory = path.resolve("C-drive-placeholder", "server");
  assert.equal(
    resolveDesktopUpdateDirectory({ env: {}, serverDirectory }),
    path.join(serverDirectory, "data", "desktop-updates"),
  );
  assert.equal(
    resolveDesktopUpdateDirectory({ env: { DESKTOP_UPDATE_DIR: " ./updates " }, serverDirectory }),
    path.resolve("./updates"),
  );
});

test("only flat updater metadata and binary assets are publicly served", () => {
  for (const value of [
    "/latest.yml",
    "/NovaSpeak-0.2.0-x64-Setup.exe",
    "/NovaSpeak-0.2.0-x64-Setup.exe.blockmap",
  ]) assert.equal(isAllowedDesktopUpdateAsset(value), true, value);

  for (const value of [
    "/novaspeak.db",
    "/.env",
    "/../latest.yml",
    "/sub/latest.yml",
    "/latest.yml%2fsecret",
    "/latest.yml?token=secret",
    "not-a-path",
    null,
  ]) assert.equal(isAllowedDesktopUpdateAsset(value), false, String(value));
});

test("update manifest is never cached while versioned assets are immutable", () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  setDesktopUpdateResponseHeaders(response, "latest.yml");
  assert.equal(headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  setDesktopUpdateResponseHeaders(response, "NovaSpeak-0.2.0-x64-Setup.exe");
  assert.equal(headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});
