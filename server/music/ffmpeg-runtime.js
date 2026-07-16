// FFmpeg 运行时定位与探测。
//
// 路径解析优先级：
// 1. 环境变量 FFMPEG_PATH（必须是存在的非空绝对路径）；
// 2. npm 包 ffmpeg-static 提供的二进制（npm install 自动按平台下载）；
// 3. 都不可用 → 稳定错误 FFMPEG_NOT_AVAILABLE。
// 绝不执行字符串 "ffmpeg"、绝不依赖系统 PATH。
//
// 探测（<ffmpegPath> -version）只在频道有待播放歌曲且有真实听众时才执行，
// 普通 Express 启动不产生任何子进程。成功结果缓存。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FFMPEG_ERROR = Object.freeze({
  NOT_AVAILABLE: "FFMPEG_NOT_AVAILABLE",
  PROBE_FAILED: "FFMPEG_PROBE_FAILED",
  PROBE_TIMEOUT: "FFMPEG_PROBE_TIMEOUT",
});

export class FfmpegRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FfmpegRuntimeError";
    this.code = code;
  }
}

// 子进程环境变量白名单：只保留进程运行必需项，
// 绝不继承 Cookie、网易云 URL、LiveKit / 数据库密钥
const SAFE_ENV_KEYS = Object.freeze([
  "SYSTEMROOT",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
]);

export function buildSafeFfmpegEnv(env = process.env) {
  const safeEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key]) safeEnv[key] = env[key];
  }
  return safeEnv;
}

async function defaultImportStatic() {
  const module = await import("ffmpeg-static");
  return module.default ?? module;
}

/**
 * 创建 FFmpeg 运行时（依赖可注入，便于测试）。
 */
export function createFfmpegRuntime({
  env = process.env,
  importStatic = defaultImportStatic,
  spawnImpl = spawn,
  existsImpl = fs.existsSync,
  probeTimeoutMs = 10_000,
} = {}) {
  let cachedProbe = null;

  async function resolveFfmpegPath() {
    const override =
      typeof env.FFMPEG_PATH === "string" ? env.FFMPEG_PATH.trim() : "";
    if (override) {
      if (!path.isAbsolute(override) || !existsImpl(override)) {
        throw new FfmpegRuntimeError(
          FFMPEG_ERROR.NOT_AVAILABLE,
          "FFMPEG_PATH 不是存在的绝对路径"
        );
      }
      return override;
    }

    let staticPath;
    try {
      staticPath = await importStatic();
    } catch {
      throw new FfmpegRuntimeError(
        FFMPEG_ERROR.NOT_AVAILABLE,
        "ffmpeg-static 不可用，请重新执行 npm install"
      );
    }
    if (
      typeof staticPath !== "string" ||
      !staticPath ||
      !existsImpl(staticPath)
    ) {
      throw new FfmpegRuntimeError(
        FFMPEG_ERROR.NOT_AVAILABLE,
        "ffmpeg-static 未提供可用的解码器文件，请重新执行 npm install"
      );
    }
    return staticPath;
  }

  function runProbe(ffmpegPath) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      // settle 只允许执行一次：error 与 close 无论何种顺序都安全
      const settle = (isError, value) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (isError) reject(value);
        else resolve(value);
      };

      let child;
      try {
        child = spawnImpl(ffmpegPath, ["-version"], {
          shell: false,
          stdio: ["ignore", "ignore", "ignore"],
          env: buildSafeFfmpegEnv(env),
          windowsHide: true,
        });
      } catch (error) {
        settle(true, mapSpawnError(error));
        return;
      }

      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 进程可能已退出
        }
        settle(
          true,
          new FfmpegRuntimeError(
            FFMPEG_ERROR.PROBE_TIMEOUT,
            "解码器探测超时"
          )
        );
      }, probeTimeoutMs);
      timer.unref?.();

      // Windows 上 spawn 失败会先 error（ENOENT），随后仍可能触发 close：
      // settled 标记保证只结算一次、timer 只清理一次
      child.once("error", (error) => settle(true, mapSpawnError(error)));
      child.once("close", (code) => {
        if (code === 0) settle(false, undefined);
        else
          settle(
            true,
            new FfmpegRuntimeError(
              FFMPEG_ERROR.PROBE_FAILED,
              "解码器探测失败"
            )
          );
      });
    });
  }

  function mapSpawnError(error) {
    if (error?.code === "ENOENT") {
      return new FfmpegRuntimeError(
        FFMPEG_ERROR.NOT_AVAILABLE,
        "找不到解码器可执行文件"
      );
    }
    return new FfmpegRuntimeError(
      FFMPEG_ERROR.PROBE_FAILED,
      "解码器无法启动"
    );
  }

  async function probeFfmpeg() {
    if (cachedProbe) return cachedProbe;
    const ffmpegPath = await resolveFfmpegPath();
    await runProbe(ffmpegPath);
    cachedProbe = { ffmpegPath };
    return cachedProbe;
  }

  return {
    resolveFfmpegPath,
    probeFfmpeg,
    clearProbeCache: () => {
      cachedProbe = null;
    },
  };
}
