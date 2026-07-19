// 音乐机器人管理器（Stage 5B v2 全新实现）。
//
// 每频道一个 worker：
//   有稳定听众 + 有 pending → 探测 FFmpeg → 公平 claim →
//   解密点歌者 Cookie → 取播放 URL → 复用 LiveKit 会话 →
//   媒体流 → FFmpeg 解码 → 逐帧 captureFrame → waitForPlayout →
//   finished → 下一首；队列空 / 无听众 → 关闭会话离开。
//
// 错误分类：
//   基础设施故障 → requeue（恢复公平游标）+ 退避（5s 起，60s 封顶），
//   不快速领取后续歌曲；
//   歌曲/账号明确不可用 → skipped；歌曲内容损坏 → failed。
//
// 铁律：任何音乐错误都不得影响 Express / Presence / 登录 / 语音；
// 绝不 process.exit、绝不 server.close、绝不 presence.close、
// 绝不 rtc 全局 dispose；所有后台 Promise 顶层 catch；
// 日志只输出稳定错误码，绝不输出 Cookie / URL / principal_key。

import { createFfmpegRuntime } from "./ffmpeg-runtime.js";
import { createMusicBotAudioSession } from "./livekit-bot.js";
import {
  createByteLimitTransform,
  openPlaybackStream,
} from "./playback-source.js";
import { decodeMediaToFrames } from "./ffmpeg-decoder.js";
import { loadNeteaseCredential } from "./library-service.js";
import {
  claimNextQueueItem,
  finishQueueItem,
  hasPendingItems,
  listChannelsWithPending,
  markQueueItemPlaybackStarted,
  requeueClaimedItem,
} from "./music-queue.js";

// 基础设施错误：requeue + 恢复游标 + 退避
const INFRASTRUCTURE_CODES = new Set([
  "FFMPEG_NOT_AVAILABLE",
  "FFMPEG_PATH_INVALID",
  "FFMPEG_PROBE_FAILED",
  "FFMPEG_PROBE_TIMEOUT",
  "FFMPEG_START_FAILED",
  "FFMPEG_ABORTED",
  "MEDIA_HEADER_TIMEOUT",
  "MEDIA_STALL_TIMEOUT",
  "MEDIA_FETCH_FAILED",
  "MEDIA_ABORTED",
  "MEDIA_PIPELINE_FAILED",
  "NETEASE_PLAYBACK_RATE_LIMITED",
  "NETEASE_PLAYBACK_REQUEST_FAILED",
  "LIVEKIT_RTC_UNAVAILABLE",
  "LIVEKIT_NOT_CONFIGURED",
  "MUSIC_BOT_CONNECT_FAILED",
  "MUSIC_BOT_PUBLISH_FAILED",
  "MUSIC_BOT_DISCONNECTED",
]);

// 歌曲/账号明确不可用：skipped，继续下一首
const SKIP_CODES = new Set([
  "NETEASE_ACCOUNT_NOT_BOUND",
  "NETEASE_CREDENTIAL_UNREADABLE",
  "NETEASE_PLAYBACK_SESSION_INVALID",
  "NETEASE_PLAYBACK_URL_UNAVAILABLE",
  "NETEASE_PLAYBACK_TRIAL_ONLY",
]);

// 歌曲内容失败：failed，继续下一首
const FAIL_CODES = new Set([
  "MEDIA_URL_REJECTED",
  "MEDIA_TOO_LARGE",
  // Range 块内部已经做过有限重试；耗尽或服务器不支持安全分块时
  // 结束当前歌曲，避免整首从头无限 requeue/replay。
  "MEDIA_RANGE_UNSUPPORTED",
  "MEDIA_RANGE_MISMATCH",
  "MEDIA_STREAM_INTERRUPTED",
  "FFMPEG_DECODE_FAILED",
  "NETEASE_PLAYBACK_RESPONSE_INVALID",
]);

const SESSION_RESET_CODES = new Set([
  "MEDIA_RANGE_UNSUPPORTED",
  "MEDIA_RANGE_MISMATCH",
  "MEDIA_STREAM_INTERRUPTED",
]);

/**
 * 播放错误分类（导出供测试）：
 * "requeue"（基础设施） / "skip"（账号或权限） / "fail"（歌曲内容）。
 * 未知错误按 fail 处理，避免无限 requeue 循环。
 */
export function classifyPlaybackError(error) {
  const code = error?.code;
  if (INFRASTRUCTURE_CODES.has(code)) return "requeue";
  if (SKIP_CODES.has(code)) return "skip";
  if (FAIL_CODES.has(code)) return "fail";
  return "fail";
}

const DEFAULT_SCAN_INTERVAL_MS = 15_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

export function createMusicBotManager({
  db,
  neteaseClient,
  presenceService,
  env = process.env,
  // 以下依赖均可注入 mock，默认使用真实实现
  ffmpegRuntime = null,
  createAudioSession = createMusicBotAudioSession,
  openMediaStream = openPlaybackStream,
  createByteLimit = createByteLimitTransform,
  decodeToFrames = decodeMediaToFrames,
  loadCredential = loadNeteaseCredential,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  backoffInitialMs = DEFAULT_BACKOFF_INITIAL_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  now = () => Date.now(),
  logger = console,
}) {
  const runtime = ffmpegRuntime || createFfmpegRuntime({ env });
  const workers = new Map(); // channelId -> { promise, abortController }
  let stopped = false;
  let scanTimer = null;

  function createPlaybackControl() {
    return {
      queueItemId: null,
      startedAtMs: null,
      paused: false,
      pausedAtMs: null,
      totalPausedMs: 0,
      skipRequested: false,
      songAbortController: null,
      resumeWaiters: new Set(),
    };
  }

  function wakePlaybackControl(control) {
    const waiters = [...control.resumeWaiters];
    control.resumeWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function resetPlaybackControl(control) {
    wakePlaybackControl(control);
    control.queueItemId = null;
    control.startedAtMs = null;
    control.paused = false;
    control.pausedAtMs = null;
    control.totalPausedMs = 0;
    control.skipRequested = false;
    control.songAbortController = null;
  }

  function setControlPaused(control, paused) {
    if (!control.queueItemId || control.paused === paused) return false;
    const timestamp = now();
    if (paused) {
      control.paused = true;
      if (control.startedAtMs !== null) control.pausedAtMs = timestamp;
      return true;
    }
    if (control.startedAtMs !== null && control.pausedAtMs !== null) {
      control.totalPausedMs += Math.max(0, timestamp - control.pausedAtMs);
    }
    control.paused = false;
    control.pausedAtMs = null;
    wakePlaybackControl(control);
    return true;
  }

  async function waitWhilePaused(control, signal) {
    while (control.paused && !signal.aborted && !control.skipRequested) {
      await new Promise((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", finish);
          control.resumeWaiters.delete(finish);
          resolve();
        };
        control.resumeWaiters.add(finish);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  function getControlSnapshot(control) {
    if (!control?.queueItemId) {
      return { active: false, queueItemId: null, paused: false, elapsedMs: 0 };
    }
    const referenceMs = control.paused && control.pausedAtMs !== null
      ? control.pausedAtMs
      : now();
    const elapsedMs = control.startedAtMs === null
      ? 0
      : Math.max(
          0,
          referenceMs - control.startedAtMs - control.totalPausedMs
        );
    return {
      active: true,
      queueItemId: String(control.queueItemId),
      paused: control.paused,
      elapsedMs,
    };
  }

  function log(level, message, errorOrCode) {
    try {
      const code =
        typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
      const diagnostics = errorOrCode?.diagnostics;
      const safeDetails = [];
      if (
        typeof diagnostics?.hostname === "string" &&
        /^[a-z0-9.-]+$/i.test(diagnostics.hostname)
      ) {
        safeDetails.push(`host=${diagnostics.hostname}`);
      }
      for (const key of ["attemptCount", "blockStart", "bytesTransferred"]) {
        if (Number.isSafeInteger(diagnostics?.[key]) && diagnostics[key] >= 0) {
          safeDetails.push(`${key}=${diagnostics[key]}`);
        }
      }
      if (Array.isArray(diagnostics?.causeCodeChain)) {
        const codes = diagnostics.causeCodeChain.filter(
          (item) => typeof item === "string" && /^[A-Z0-9_]+$/.test(item)
        );
        if (codes.length) safeDetails.push(`causes=${codes.slice(0, 5).join(",")}`);
      }
      const suffix = safeDetails.length ? ` [${safeDetails.join(" ")}]` : "";
      logger?.[level]?.(
        code
          ? `[music-bot] ${message}（${code}）${suffix}`
          : `[music-bot] ${message}${suffix}`
      );
    } catch {
      // 日志失败绝不影响播放
    }
  }

  // 可被 Abort 打断的等待；返回 false 表示已被中止
  function abortableDelay(ms, signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function playOneSong({
    channelId,
    receipt,
    ffmpegPath,
    signal,
    sessionBox,
    control,
  }) {
    const item = receipt.queueItem;

    // 点歌者自己的凭据：A 的歌只能用 A 的 Cookie
    const { cookie } = loadCredential(db, item.principal_key, env);
    const { url } = await neteaseClient.getSongPlaybackUrl({
      songId: item.song_id,
      cookie,
    });
    // URL / Cookie 只在本函数作用域中短暂存在，不写日志、不入库、不回传

    if (!sessionBox.session) {
      sessionBox.session = await createAudioSession({
        channelId,
        env,
        // 机器人被 LiveKit 管理操作移出时立即中止当前解码；worker
        // 会把歌曲放回原公平位置、关闭旧会话并在退避后重新加入。
        onUnexpectedDisconnect: () => control.songAbortController?.abort(),
      });
    }
    const session = sessionBox.session;

    const mediaStream = await openMediaStream(url, { signal });
    const byteLimit = createByteLimit();
    let playbackStarted = false;
    await decodeToFrames({
      ffmpegPath,
      mediaStream,
      byteLimit,
      signal,
      env,
      onFrame: async (frame) => {
        await waitWhilePaused(control, signal);
        if (signal.aborted || control.skipRequested) {
          const error = new Error("音乐播放已中止");
          error.code = "FFMPEG_ABORTED";
          throw error;
        }
        if (!playbackStarted) {
          playbackStarted = true;
          const startedAt = now();
          control.startedAtMs = startedAt;
          control.pausedAtMs = null;
          control.totalPausedMs = 0;
          markQueueItemPlaybackStarted(db, {
            queueItemId: item.id,
            now: startedAt,
          });
        }
        await session.captureFrame(frame);
      },
    });
    if (control.skipRequested) {
      const error = new Error("管理员已切换下一首");
      error.code = "MUSIC_BOT_ADMIN_SKIP";
      throw error;
    }
    await session.waitForPlayout();
  }

  async function closeSession(sessionBox) {
    const session = sessionBox.session;
    sessionBox.session = null;
    if (!session) return;
    try {
      await session.close();
    } catch {
      // close 是清理路径，失败不得影响 Express 或队列恢复
    }
  }

  async function runWorker(
    channelId,
    abortController,
    sessionBox,
    control
  ) {
    const signal = abortController.signal;
    let backoffMs = 0;

    try {
      for (;;) {
        if (stopped || signal.aborted) break;
        // 无稳定听众 / 无待播放歌曲 → 机器人离开
        if (!presenceService.hasUsersInChannel(channelId)) break;
        if (!hasPendingItems(db, channelId)) break;

        // 领取之前先探测解码器：失败则不 claim、队列保持 pending、退避
        let ffmpegPath;
        try {
          const probe = await runtime.probeFfmpeg();
          ffmpegPath = probe.ffmpegPath;
        } catch (error) {
          log("error", "解码器不可用，暂停播放", error?.code);
          backoffMs = backoffMs
            ? Math.min(backoffMs * 2, backoffMaxMs)
            : backoffInitialMs;
          runtime.clearProbeCache?.();
          if (!(await abortableDelay(backoffMs, signal))) break;
          continue;
        }

        const receipt = claimNextQueueItem(db, { channelId });
        if (!receipt) break;

        control.queueItemId = String(receipt.queueItem.id);
        control.startedAtMs = null;
        control.paused = false;
        control.pausedAtMs = null;
        control.totalPausedMs = 0;
        control.skipRequested = false;
        const songAbortController = new AbortController();
        control.songAbortController = songAbortController;
        const abortSong = () => songAbortController.abort();
        if (signal.aborted) abortSong();
        else signal.addEventListener("abort", abortSong, { once: true });

        try {
          await playOneSong({
            channelId,
            receipt,
            ffmpegPath,
            signal: songAbortController.signal,
            sessionBox,
            control,
          });
          finishQueueItem(db, {
            queueItemId: receipt.queueItem.id,
            outcome: "finished",
          });
          backoffMs = 0; // 成功一首清除退避
        } catch (error) {
          if (control.skipRequested) {
            await closeSession(sessionBox);
            finishQueueItem(db, {
              queueItemId: receipt.queueItem.id,
              outcome: "skipped",
              failureCode: "SKIPPED_BY_ADMIN",
            });
            log("info", "管理员已切换下一首", "SKIPPED_BY_ADMIN");
            backoffMs = 0;
            continue;
          }
          const classification = classifyPlaybackError(error);
          if (classification === "requeue") {
            // 基础设施故障：恢复公平位置，不快速领取下一首
            requeueClaimedItem(db, {
              queueItemId: receipt.queueItem.id,
              previousLastServedBucketOrder:
                receipt.previousLastServedBucketOrder,
            });
            // 网络/FFmpeg/LiveKit 故障后不复用可能已经损坏的 AudioSource
            // 或 Room；下一次重试必须建立全新的机器人音频会话。
            await closeSession(sessionBox);
            log("error", "播放暂时失败，歌曲已放回队列", error);
            backoffMs = backoffMs
              ? Math.min(backoffMs * 2, backoffMaxMs)
              : backoffInitialMs;
            if (!(await abortableDelay(backoffMs, signal))) break;
          } else {
            if (SESSION_RESET_CODES.has(error?.code)) {
              await closeSession(sessionBox);
            }
            finishQueueItem(db, {
              queueItemId: receipt.queueItem.id,
              outcome: classification === "skip" ? "skipped" : "failed",
              failureCode:
                typeof error?.code === "string" ? error.code : "UNKNOWN",
            });
            log(
              "warn",
              classification === "skip" ? "歌曲已跳过" : "歌曲播放失败",
              error
            );
          }
        } finally {
          signal.removeEventListener("abort", abortSong);
          resetPlaybackControl(control);
        }
      }
    } finally {
      await closeSession(sessionBox);
    }
  }

  /**
   * 触发频道播放检查（入队成功后调用）。不阻塞 HTTP 响应。
   */
  function kick(channelId) {
    if (stopped) return;
    if (typeof channelId !== "string" || !channelId) return;
    if (workers.has(channelId)) return; // 同频道只有一个 worker

    const abortController = new AbortController();
    const sessionBox = { session: null };
    const control = createPlaybackControl();
    const promise = runWorker(
      channelId,
      abortController,
      sessionBox,
      control
    )
      .catch((error) => {
        // 顶层兜底：任何 worker 异常都不得外溢
        log("error", "播放任务异常结束", error?.code);
      })
      .finally(() => {
        workers.delete(channelId);
      });
    workers.set(channelId, {
      promise,
      abortController,
      sessionBox,
      control,
    });
  }

  function getPlaybackState(channelId) {
    return getControlSnapshot(workers.get(channelId)?.control);
  }

  function setPaused(channelId, paused) {
    const worker = workers.get(channelId);
    if (!worker?.control?.queueItemId) {
      return { changed: false, ...getPlaybackState(channelId) };
    }
    const changed = setControlPaused(worker.control, paused === true);
    return { changed, ...getControlSnapshot(worker.control) };
  }

  async function skip(channelId) {
    const worker = workers.get(channelId);
    const control = worker?.control;
    if (!worker || !control?.queueItemId || control.skipRequested) {
      return { changed: false, ...getPlaybackState(channelId) };
    }
    control.skipRequested = true;
    setControlPaused(control, false);
    control.songAbortController?.abort();
    // 立即关闭音频会话以清掉 AudioSource 内最多约 200ms 的残余缓冲；
    // worker 会在 catch 中把当前项标记 skipped，再创建新会话播放下一首。
    await closeSession(worker.sessionBox);
    return { changed: true, ...getControlSnapshot(control) };
  }

  function scan() {
    if (stopped) return;
    try {
      for (const channelId of listChannelsWithPending(db)) {
        if (presenceService.hasUsersInChannel(channelId)) kick(channelId);
      }
    } catch (error) {
      log("error", "队列扫描失败", error?.code);
    }
  }

  function start() {
    if (stopped || scanTimer) return;
    scanTimer = setInterval(scan, scanIntervalMs);
    scanTimer.unref?.();
    // 启动时立刻扫描一次（恢复重启前的 pending）
    queueMicrotask(scan);
  }

  /**
   * 停止（服务关闭时调用，防重入）：Abort 全部 worker，
   * 播放中的歌曲经 FFMPEG_ABORTED / MEDIA_ABORTED 分类回到 pending。
   */
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    const pending = [...workers.values()];
    for (const worker of pending) {
      worker.abortController.abort();
    }
    await Promise.allSettled(pending.map((worker) => worker.promise));
  }

  return {
    start,
    stop,
    kick,
    scan,
    getPlaybackState,
    setPaused,
    skip,
    get activeChannelCount() {
      return workers.size;
    },
  };
}
