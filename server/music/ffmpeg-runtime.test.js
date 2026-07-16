import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  FFMPEG_ERROR,
  buildSafeFfmpegEnv,
  createFfmpegRuntime,
} from "./ffmpeg-runtime.js";

class FakeChild extends EventEmitter {
  killed = [];
  kill(signalName) {
    this.killed.push(signalName);
  }
}

function makeRuntime(overrides = {}) {
  const spawnedCalls = [];
  const child = overrides.child ?? new FakeChild();
  const runtime = createFfmpegRuntime({
    env: overrides.env ?? {},
    importStatic:
      overrides.importStatic ?? (async () => "/static/path/ffmpeg"),
    existsImpl: overrides.existsImpl ?? (() => true),
    probeTimeoutMs: overrides.probeTimeoutMs ?? 200,
    spawnImpl:
      overrides.spawnImpl ??
      ((command, args, options) => {
        spawnedCalls.push({ command, args, options });
        if (overrides.spawnThrows) throw overrides.spawnThrows;
        queueMicrotask(() => overrides.onSpawn?.(child));
        return child;
      }),
  });
  return { runtime, spawnedCalls, child };
}

test("FFMPEG_PATH 为存在的绝对路径时优先使用", async () => {
  const { runtime } = makeRuntime({
    env: { FFMPEG_PATH: "/custom/ffmpeg" },
    existsImpl: (p) => p === "/custom/ffmpeg",
    importStatic: async () => {
      throw new Error("不应加载 ffmpeg-static");
    },
  });
  assert.equal(await runtime.resolveFfmpegPath(), "/custom/ffmpeg");
});

test("FFMPEG_PATH 相对路径 / 不存在的绝对路径 → PATH_INVALID，且不回退 ffmpeg-static", async () => {
  for (const env of [
    { FFMPEG_PATH: "relative/ffmpeg" },
    { FFMPEG_PATH: "/missing/ffmpeg" },
  ]) {
    let staticLoaded = false;
    const { runtime } = makeRuntime({
      env,
      existsImpl: () => false,
      importStatic: async () => {
        staticLoaded = true;
        return "/static/path/ffmpeg";
      },
    });
    await assert.rejects(
      () => runtime.resolveFfmpegPath(),
      (error) =>
        error.code === FFMPEG_ERROR.PATH_INVALID &&
        // 错误信息不包含配置的完整本地路径
        !error.message.includes(env.FFMPEG_PATH)
    );
    assert.equal(staticLoaded, false, "配置无效时不得静默回退 ffmpeg-static");
  }
});

test("未配置 FFMPEG_PATH 时使用 ffmpeg-static", async () => {
  const { runtime } = makeRuntime({});
  assert.equal(await runtime.resolveFfmpegPath(), "/static/path/ffmpeg");
});

test("FFMPEG_PATH 为空字符串 / 纯空白时使用 ffmpeg-static", async () => {
  for (const value of ["", "   ", "\t"]) {
    const { runtime } = makeRuntime({ env: { FFMPEG_PATH: value } });
    assert.equal(await runtime.resolveFfmpegPath(), "/static/path/ffmpeg");
  }
});

test("配置的覆盖路径 probe 出现 ENOENT 时不回退 ffmpeg-static", async () => {
  let staticLoaded = false;
  const { runtime } = makeRuntime({
    env: { FFMPEG_PATH: "/custom/ffmpeg" },
    existsImpl: (p) => p === "/custom/ffmpeg",
    importStatic: async () => {
      staticLoaded = true;
      return "/static/path/ffmpeg";
    },
    onSpawn: (child) => {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      child.emit("error", error);
      child.emit("close", 1);
    },
  });
  await assert.rejects(
    () => runtime.probeFfmpeg(),
    (error) =>
      error.code === FFMPEG_ERROR.NOT_AVAILABLE &&
      !error.message.includes("/custom/ffmpeg")
  );
  assert.equal(staticLoaded, false);
});

test("ffmpeg-static 返回相对路径时报 NOT_AVAILABLE", async () => {
  const { runtime } = makeRuntime({
    importStatic: async () => "relative/ffmpeg",
  });
  await assert.rejects(
    () => runtime.resolveFfmpegPath(),
    (error) => error.code === FFMPEG_ERROR.NOT_AVAILABLE
  );
});

test("ffmpeg-static 返回空路径 / 文件缺失 / 加载失败 → NOT_AVAILABLE", async () => {
  for (const overrides of [
    { importStatic: async () => "" },
    { importStatic: async () => null },
    { importStatic: async () => "/static/missing", existsImpl: () => false },
    {
      importStatic: async () => {
        throw new Error("module missing");
      },
    },
  ]) {
    const { runtime } = makeRuntime(overrides);
    await assert.rejects(
      () => runtime.resolveFfmpegPath(),
      (error) => error.code === FFMPEG_ERROR.NOT_AVAILABLE
    );
  }
});

test("probe：ENOENT error 映射 NOT_AVAILABLE，随后 close 不重复结算", async () => {
  const child = new FakeChild();
  const { runtime } = makeRuntime({
    child,
    onSpawn: (spawnedChild) => {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      spawnedChild.emit("error", error);
      // Windows 行为：error 后仍可能触发 close
      spawnedChild.emit("close", 1);
      spawnedChild.emit("close", 1);
    },
  });
  await assert.rejects(
    () => runtime.probeFfmpeg(),
    (error) => error.code === FFMPEG_ERROR.NOT_AVAILABLE
  );
});

test("probe：EACCES 映射 PROBE_FAILED", async () => {
  const { runtime } = makeRuntime({
    onSpawn: (child) => {
      const error = new Error("spawn EACCES");
      error.code = "EACCES";
      child.emit("error", error);
    },
  });
  await assert.rejects(
    () => runtime.probeFfmpeg(),
    (error) => error.code === FFMPEG_ERROR.PROBE_FAILED
  );
});

test("probe：close 后迟到的 error 被忽略（只结算一次）", async () => {
  const child = new FakeChild();
  const { runtime } = makeRuntime({
    child,
    onSpawn: (spawnedChild) => {
      spawnedChild.emit("close", 0);
      spawnedChild.emit("error", new Error("late error"));
    },
  });
  const result = await runtime.probeFfmpeg();
  assert.equal(result.ffmpegPath, "/static/path/ffmpeg");
});

test("probe：非零退出码 → PROBE_FAILED", async () => {
  const { runtime } = makeRuntime({
    onSpawn: (child) => child.emit("close", 1),
  });
  await assert.rejects(
    () => runtime.probeFfmpeg(),
    (error) => error.code === FFMPEG_ERROR.PROBE_FAILED
  );
});

test("probe：超时 → PROBE_TIMEOUT 且尝试终止子进程", async () => {
  const child = new FakeChild();
  const { runtime } = makeRuntime({
    child,
    probeTimeoutMs: 30,
    onSpawn: () => {
      // 永不触发 close/error → 走超时
    },
  });
  // 生产中探测 timer 是 unref 的，测试里需要保活事件循环
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    await assert.rejects(
      () => runtime.probeFfmpeg(),
      (error) => error.code === FFMPEG_ERROR.PROBE_TIMEOUT
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(child.killed, ["SIGKILL"]);
  // 超时结算后迟到的 close 不产生副作用
  child.emit("close", 137);
});

test("probe 成功结果被缓存，只 spawn 一次；清缓存后重新探测", async () => {
  const { runtime, spawnedCalls } = makeRuntime({
    onSpawn: (child) => child.emit("close", 0),
  });
  const first = await runtime.probeFfmpeg();
  const second = await runtime.probeFfmpeg();
  assert.equal(first, second);
  assert.equal(spawnedCalls.length, 1);

  runtime.clearProbeCache();
  await runtime.probeFfmpeg();
  assert.equal(spawnedCalls.length, 2);
});

test("spawn 参数安全：shell:false + 环境白名单", async () => {
  const { runtime, spawnedCalls } = makeRuntime({
    env: {
      FFMPEG_PATH: "",
      MUSIC_CREDENTIAL_KEY: "secret-key",
      LIVEKIT_API_SECRET: "livekit-secret",
      HOME: "/home/user",
      TEMP: "/tmp",
    },
    onSpawn: (child) => child.emit("close", 0),
  });
  await runtime.probeFfmpeg();

  const call = spawnedCalls[0];
  assert.equal(call.command, "/static/path/ffmpeg");
  assert.deepEqual(call.args, ["-version"]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  // 白名单环境：保留 HOME/TEMP，剔除所有密钥
  assert.deepEqual(call.options.env, { HOME: "/home/user", TEMP: "/tmp" });
});

test("buildSafeFfmpegEnv 只保留白名单键", () => {
  const safeEnv = buildSafeFfmpegEnv({
    SystemRoot: "C:\\Windows",
    PATH: "/usr/bin",
    MUSIC_U: "cookie-value",
    GUEST_SESSION_SECRET: "secret",
    TMPDIR: "/tmp",
  });
  assert.deepEqual(safeEnv, { SystemRoot: "C:\\Windows", TMPDIR: "/tmp" });
});
