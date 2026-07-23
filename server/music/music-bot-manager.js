// 音乐机器人管理器（Stage 5B v2 + DJ 等功率交叉淡化）。
//
// 每频道一个 worker：
//   有稳定听众 + 有 pending → 探测 FFmpeg → 公平 claim →
//   解密点歌者 Cookie → 取播放 URL → 复用 LiveKit 会话 →
//   媒体流 → FFmpeg 解码 → 逐帧 captureFrame → waitForPlayout →
//   finished → 下一首；队列空 / 无听众 → 关闭会话离开。
//
// DJ 过渡（每频道开关，默认关闭）状态机——per-song runner：
//   idle            worker 空闲 / 本歌曲不做过渡（DJ 关闭时恒为此态）
//   playing         正常逐帧推送当前歌曲
//   preparing_next  已锁定公平候选并把其解码预取进有界 PCM 缓冲
//                   （内存 reservation：候选在数据库中保持 pending，
//                   公平游标不动；服务重启 reservation 自然失效不丢歌）
//   crossfading     等功率混音重叠期（旧歌 cos 淡出、新歌 sin 淡入）
//   paused          control.paused=true，叠加在以上任何状态之上：
//                   两路解码经背压一起冻结，过渡进度按帧数冻结
//   stopping        skip / worker Abort / stop() 已触发，等待清理
// 真正的队列状态迁移只发生在 handoverCrossfadeQueueItem 单事务里；
// 同频道自始至终只有一个 Room / AudioSource / 已发布音轨。
//
// 错误分类：
//   基础设施故障 → requeue（恢复公平游标）+ 退避（5s 起，60s 封顶），
//   不快速领取后续歌曲；
//   歌曲/账号明确不可用 → skipped；歌曲内容损坏 → failed。
//   下一首预取失败不影响当前歌曲：候选保持 pending，退化为普通串行
//   切换，由随后的正常 claim 走同一套分类。
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
  getQueueItemStatus,
  handoverCrossfadeQueueItem,
  hasPendingItems,
  isDjTransitionEnabled,
  listChannelsWithPending,
  markQueueItemPlaybackStarted,
  peekNextQueueCandidate,
  requeueClaimedItem,
} from "./music-queue.js";
import {
  PCM_FRAME_MS,
  crossfadeProgress,
  equalPowerGains,
  mixFrames,
  scaleFrame,
} from "./crossfade-mixer.js";
import { createPcmFrameBuffer } from "./pcm-frame-buffer.js";

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
const DEFAULT_IDLE_PAUSE_MS = 120_000;
const DEFAULT_BACKOFF_INITIAL_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 60_000;

/**
 * DJ 过渡默认参数（测试可整体注入覆盖）。
 * 帧长固定 10ms：预取缓冲上限 800 帧 = 8 秒 = 800 × 1920 字节 ≈ 1.5 MiB。
 * 缓冲上限（8 秒）小于淡化时长（10 秒）是刻意的：就绪门槛取
 * min(淡化帧数, 缓冲上限)，淡化期间下一首解码器持续实时补充。
 */
export const DJ_TRANSITION_DEFAULTS = Object.freeze({
  crossfadeMs: 10_000,         // 交叉淡化重叠时长：10 秒 = 1000 帧
  prepareLeadMs: 12_000,       // 预计剩余约 12 秒开始准备下一首
  minCurrentDurationMs: 20_000, // 当前歌短于此值回退普通串行切换
  minNextDurationMs: 10_000,   // 候选歌短于此值不作为淡化对象
  prepBufferMaxFrames: 800,    // 有界预取缓冲：8 秒 PCM
  rampMs: 300,                 // 跳过 / 提前结束时把新歌拉满的时长
  checkIntervalFrames: 100,    // 每 1 秒重读开关与候选有效性
});

function abortPlaybackError() {
  const error = new Error("音乐播放已中止");
  error.code = "FFMPEG_ABORTED";
  return error;
}

function isAbortCode(code) {
  return code === "FFMPEG_ABORTED" || code === "MEDIA_ABORTED";
}

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
  idlePauseMs = DEFAULT_IDLE_PAUSE_MS,
  backoffInitialMs = DEFAULT_BACKOFF_INITIAL_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  djTransition = {},
  now = () => Date.now(),
  logger = console,
}) {
  const runtime = ffmpegRuntime || createFfmpegRuntime({ env });
  const djOptions = { ...DJ_TRANSITION_DEFAULTS, ...djTransition };
  const workers = new Map(); // channelId -> { promise, abortController }
  const emptySinceByChannel = new Map();
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
      transitionPhase: null,
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
    control.transitionPhase = null;
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

  function controlTransitionState(control) {
    if (control?.transitionPhase === "crossfading") return "crossfading";
    if (control?.transitionPhase === "preparing") return "preparing";
    return "idle";
  }

  function getControlSnapshot(control) {
    if (!control?.queueItemId) {
      return {
        active: false,
        queueItemId: null,
        paused: false,
        elapsedMs: 0,
        transitionState: "idle",
      };
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
      transitionState: controlTransitionState(control),
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

  /**
   * 每首歌一个过渡 runner：封装预取 reservation、等功率混音与交接。
   * DJ 关闭 / 歌曲不合格时 processFrame 与既有串行路径逐帧等价
   * （仅多出常数次本地判断，绝不触碰第二个解码任务）。
   */
  function createTransitionRunner({
    channelId,
    item,
    control,
    session,
    ffmpegPath,
    abortOldDecode,
    initialFramesCaptured = 0,
  }) {
    const durationMs = Math.max(0, Number(item.duration_ms) || 0);
    const totalFramesEstimate = Math.floor(durationMs / PCM_FRAME_MS);
    const crossfadeFrames = Math.max(
      1,
      Math.round(djOptions.crossfadeMs / PCM_FRAME_MS)
    );
    const prepareLeadFrames = Math.max(
      crossfadeFrames + 1,
      Math.round(djOptions.prepareLeadMs / PCM_FRAME_MS)
    );
    const rampFrames = Math.max(1, Math.round(djOptions.rampMs / PCM_FRAME_MS));
    const checkIntervalFrames = Math.max(1, djOptions.checkIntervalFrames);
    // duration_ms 只作预计结束时间；无效或太短一律回退普通串行播放
    const currentEligible =
      totalFramesEstimate > 0 && durationMs >= djOptions.minCurrentDurationMs;

    const state = {
      // 实际已推送帧数（唯一位置权威，含混音帧）；交接歌曲从淡化期间
      // 已经播出的帧数起算，保证下一次过渡时机不漂移
      framesCaptured: Math.max(0, initialFramesCaptured),
      prep: null,        // { candidate, buffer, abortController, decodeResult }
      fade: null,        // { framesMixed, totalFrames, newFramesCaptured, lastNewGain, lastOldGain }
      restoreRamp: null, // 淡化中断后把旧歌平滑拉回全量
      oldSongCut: false,
      skipCut: false,
      rejectedCandidateIds: new Set(),
    };

    function syncControlPhase() {
      control.transitionPhase = state.fade
        ? "crossfading"
        : state.prep
          ? "preparing"
          : "playing";
    }

    function cancelPrep() {
      const prep = state.prep;
      if (!prep) return;
      state.prep = null;
      try {
        prep.abortController.abort();
      } catch {
        // 预取清理失败不影响当前歌曲
      }
      prep.buffer.close();
      syncControlPhase();
    }

    function prepReady(prep) {
      // 就绪门槛不能超过缓冲上限（10 秒淡化 vs 8 秒缓冲）：
      // 预热到上限即可开始，淡化期间解码器边播边补
      const targetFrames = Math.min(
        crossfadeFrames,
        djOptions.prepBufferMaxFrames
      );
      return prep.buffer.size >= targetFrames || prep.buffer.ended;
    }

    function candidateStillValid(candidate) {
      if (
        getQueueItemStatus(db, {
          channelId,
          queueItemId: candidate.queueItemId,
        }) !== "pending"
      ) {
        return false;
      }
      const head = peekNextQueueCandidate(db, { channelId });
      return head !== null && head.queueItemId === candidate.queueItemId;
    }

    function startPrep(candidate) {
      const abortController = new AbortController();
      const buffer = createPcmFrameBuffer({
        maxFrames: djOptions.prepBufferMaxFrames,
      });
      const prep = { candidate, abortController, buffer, decodeResult: null };
      const task = (async () => {
        // 候选歌曲只用候选点歌者自己的凭据；URL/Cookie 不出本函数作用域
        const { cookie } = loadCredential(db, candidate.principalKey, env);
        const { url } = await neteaseClient.getSongPlaybackUrl({
          songId: candidate.songId,
          cookie,
        });
        const mediaStream = await openMediaStream(url, {
          signal: abortController.signal,
        });
        const byteLimit = createByteLimit();
        return decodeToFrames({
          ffmpegPath,
          mediaStream,
          byteLimit,
          signal: abortController.signal,
          env,
          onFrame: async (frame) => {
            const accepted = await buffer.push(frame);
            if (!accepted) {
              throw abortPlaybackError();
            }
          },
        });
      })();
      // 统一转为已结算对象：预取失败绝不产生 unhandledRejection
      prep.decodeResult = task.then(
        (value) => {
          buffer.markEnded();
          return { ok: true, value };
        },
        (error) => {
          buffer.fail(error);
          return { ok: false, error };
        }
      );
      return prep;
    }

    function maybeStartPrep() {
      if (state.prep || state.fade || state.restoreRamp) return;
      if (!currentEligible) return;
      const remaining = totalFramesEstimate - state.framesCaptured;
      if (remaining > prepareLeadFrames) return;
      if (remaining <= crossfadeFrames) return; // 太晚：本次退化为串行
      if (state.framesCaptured % checkIntervalFrames !== 0) return;
      if (!isDjTransitionEnabled(db, channelId)) return;
      const candidate = peekNextQueueCandidate(db, { channelId });
      if (!candidate) return; // 无下一首：不启动第二个 FFmpeg
      if (state.rejectedCandidateIds.has(candidate.queueItemId)) return;
      if (candidate.durationMs < djOptions.minNextDurationMs) {
        state.rejectedCandidateIds.add(candidate.queueItemId);
        return;
      }
      state.prep = startPrep(candidate);
      syncControlPhase();
    }

    function reviewPrep() {
      const prep = state.prep;
      if (!prep || state.fade) return;
      if (state.framesCaptured % checkIntervalFrames !== 0) return;
      if (prep.buffer.failed) {
        // 预取失败：候选保持 pending，由随后的串行 claim 走既有分类；
        // 当前歌曲继续播放，本次切换退化为普通切歌
        state.rejectedCandidateIds.add(prep.candidate.queueItemId);
        log("warn", "DJ 预取失败，本次切换退化为普通切歌", prep.buffer.failed);
        cancelPrep();
        return;
      }
      if (!isDjTransitionEnabled(db, channelId)) {
        cancelPrep(); // 关闭 DJ：立即取消预取，当前歌曲继续
        return;
      }
      if (!candidateStillValid(prep.candidate)) {
        cancelPrep(); // 候选被取消/置顶/洗牌顶替：取消预取并重新选择
      }
    }

    function maybeStartCrossfade() {
      const prep = state.prep;
      if (!prep || state.fade) return;
      const remaining = totalFramesEstimate - state.framesCaptured;
      if (remaining > crossfadeFrames) return;
      if (prep.buffer.failed) return; // reviewPrep 下个周期清理
      if (!prepReady(prep)) return; // 迟一点就绪就迟一点开始（缩短淡化）
      if (!candidateStillValid(prep.candidate)) {
        cancelPrep();
        return;
      }
      // 正常淡化必须走满全部帧数，不因 duration_ms 误差压缩曲线：
      // 旧歌只会因「混满全部帧」「实际 EOF」「跳过/清空/停止」终止。
      // 旧歌若早于淡化走满而 EOF，走既有 300ms 平滑接管路径。
      state.fade = {
        framesMixed: 0,
        totalFrames: crossfadeFrames,
        newFramesCaptured: 0,
        lastOldGain: 1,
        lastNewGain: 0,
      };
      syncControlPhase();
    }

    function beginRestoreRamp() {
      const fromGain = state.fade ? state.fade.lastOldGain : 1;
      state.fade = null;
      cancelPrep();
      state.restoreRamp = {
        fromGain,
        framesDone: 0,
        totalFrames: rampFrames,
      };
      syncControlPhase();
    }

    async function captureRestoreFrame(oldFrame) {
      const ramp = state.restoreRamp;
      const progress = Math.min(1, (ramp.framesDone + 1) / ramp.totalFrames);
      const gain = ramp.fromGain + (1 - ramp.fromGain) * progress;
      ramp.framesDone += 1;
      await session.captureFrame(scaleFrame(oldFrame, gain));
      if (ramp.framesDone >= ramp.totalFrames) {
        state.restoreRamp = null;
      }
      return { oldDone: false };
    }

    async function captureCrossfadeFrame(oldFrame) {
      const fade = state.fade;
      const prep = state.prep;
      // 已出声后周期性确认候选未被取消；取消则终止新歌、旧歌平滑回满
      if (
        fade.framesMixed > 0 &&
        fade.framesMixed % checkIntervalFrames === 0 &&
        getQueueItemStatus(db, {
          channelId,
          queueItemId: prep.candidate.queueItemId,
        }) !== "pending"
      ) {
        beginRestoreRamp();
        return captureRestoreFrame(oldFrame);
      }
      if (prep.buffer.failed || (prep.buffer.ended && prep.buffer.size === 0)) {
        // 新歌中途失败或过短耗尽：撤销淡化，旧歌回到全量
        if (prep.buffer.failed) {
          log("warn", "DJ 淡化中预取中断，恢复当前歌曲", prep.buffer.failed);
        }
        beginRestoreRamp();
        return captureRestoreFrame(oldFrame);
      }
      // 完整 0→1 曲线：首帧恰为 old=1/new=0，末帧恰为 old=0/new=1
      const gains = equalPowerGains(
        crossfadeProgress(fade.framesMixed, fade.totalFrames)
      );
      const newFrame = prep.buffer.take();
      let outFrame;
      if (newFrame) {
        outFrame = mixFrames(oldFrame, newFrame, gains.oldGain, gains.newGain);
        fade.framesMixed += 1;
        fade.newFramesCaptured += 1;
        fade.lastOldGain = gains.oldGain;
        fade.lastNewGain = gains.newGain;
      } else {
        // 罕见 underrun（预取临时慢于实时）：冻结进度，只推旧歌
        outFrame = scaleFrame(oldFrame, gains.oldGain);
      }
      await session.captureFrame(outFrame);
      if (fade.framesMixed >= fade.totalFrames) {
        // 淡化完成：旧歌增益已为 0，可以终止其剩余尾部
        state.oldSongCut = true;
        abortOldDecode();
        return { oldDone: true };
      }
      return { oldDone: false };
    }

    return {
      get oldSongCut() {
        return state.oldSongCut;
      },
      get skipCut() {
        return state.skipCut;
      },
      isCrossfading() {
        return Boolean(state.fade);
      },

      /** 淡化期间管理员点了下一首：立即切断旧歌，finishOldSong 快速拉满新歌 */
      requestSkipCut() {
        if (!state.fade) return;
        state.skipCut = true;
        state.oldSongCut = true;
        abortOldDecode();
      },

      /** 当前歌曲的每一帧都经过这里（串行 / 预取 / 混音统一入口） */
      async processFrame(oldFrame) {
        state.framesCaptured += 1;
        if (state.oldSongCut) return { oldDone: true };
        if (state.restoreRamp) return captureRestoreFrame(oldFrame);
        if (!state.fade) {
          maybeStartPrep();
          reviewPrep();
          maybeStartCrossfade();
        }
        if (state.fade) return captureCrossfadeFrame(oldFrame);
        await session.captureFrame(oldFrame);
        return { oldDone: false };
      },

      /**
       * 旧歌解码结束后的收尾。
       * 返回 { handedOver:false }（普通串行结束）或
       * { handedOver:true, carried }（已事务交接，worker 下一轮接管新歌）。
       */
      async finishOldSong({ signal }) {
        // 旧歌提前结束但候选已就绪且淡化未开始：短时间拉入新歌接管
        if (
          !state.fade &&
          state.prep &&
          !state.prep.buffer.failed &&
          prepReady(state.prep) &&
          !state.skipCut &&
          isDjTransitionEnabled(db, channelId) &&
          candidateStillValid(state.prep.candidate)
        ) {
          state.fade = {
            framesMixed: 0,
            totalFrames: 1,
            newFramesCaptured: 0,
            lastOldGain: 0,
            lastNewGain: 0,
          };
          syncControlPhase();
        }
        if (!state.fade || !state.prep) {
          return { handedOver: false };
        }

        const prep = state.prep;
        const fade = state.fade;
        // 走满的淡化终点已精确 old=0/new=1，无需任何补偿；300ms ramp
        // 只用于提前接管：旧歌提前结束、淡化中跳过、旧歌结束后才就绪
        const fadeCompleted = fade.framesMixed >= fade.totalFrames;
        const fromGain = fade.lastNewGain;
        const framesToRamp = fadeCompleted ? 0 : rampFrames;
        try {
          for (let index = 0; index < framesToRamp; index += 1) {
            await waitWhilePaused(control, signal);
            if (signal.aborted) throw abortPlaybackError();
            const frame = await prep.buffer.pull();
            if (frame === null) break;
            const gain =
              fromGain + (1 - fromGain) * ((index + 1) / framesToRamp);
            await session.captureFrame(scaleFrame(frame, gain));
            fade.newFramesCaptured += 1;
          }
        } catch (error) {
          if (signal.aborted || isAbortCode(error?.code)) throw error;
          // 新歌在拉满阶段失败：绝不重播旧歌，退化为普通串行切换，
          // 候选保持 pending 由随后 claim 走既有分类
          log("warn", "DJ 接管阶段预取中断，退化为普通切歌", error);
          state.fade = null;
          return { handedOver: false };
        }

        const handoverNow = now();
        const startedAt =
          handoverNow - fade.newFramesCaptured * PCM_FRAME_MS;
        const receipt = handoverCrossfadeQueueItem(db, {
          channelId,
          currentQueueItemId: item.id,
          nextQueueItemId: prep.candidate.queueItemId,
          outcome: state.skipCut ? "skipped" : "finished",
          startedAt,
          now: handoverNow,
        });
        if (!receipt) {
          // 候选在最后一刻被取消：停止新歌声音，退化为普通结束
          state.fade = null;
          return { handedOver: false };
        }

        // 所有权移交给 worker 下一轮迭代；cleanup 不再触碰这些资源
        state.prep = null;
        state.fade = null;
        control.queueItemId = String(receipt.queueItem.id);
        control.startedAtMs = startedAt;
        control.paused = false;
        control.pausedAtMs = null;
        control.totalPausedMs = 0;
        control.skipRequested = false;
        control.transitionPhase = "playing";
        return {
          handedOver: true,
          carried: {
            receipt,
            buffer: prep.buffer,
            abortController: prep.abortController,
            decodeResult: prep.decodeResult,
            ffmpegPath,
            controlStartedAtMs: startedAt,
            framesAlreadyCaptured: fade.newFramesCaptured,
          },
        };
      },

      /** 清理未移交的预取资源（正常、错误、Abort 路径统一走到） */
      cleanup() {
        state.fade = null;
        state.restoreRamp = null;
        cancelPrep();
      },
    };
  }

  /**
   * 消费交接来的歌曲：先读预取缓冲存量，再随解码任务实时推进。
   * 绝不重新解码——「下一首转正后不会从头开始」由此保证。
   */
  async function consumeCarriedFrames({ carried, runner, control, signal }) {
    const { buffer, decodeResult } = carried;
    for (;;) {
      await waitWhilePaused(control, signal);
      if (signal.aborted) throw abortPlaybackError();
      if (control.skipRequested) {
        if (runner.isCrossfading()) {
          runner.requestSkipCut();
        } else {
          throw abortPlaybackError();
        }
      }
      if (runner.oldSongCut) break;
      const frame = await buffer.pull(); // 解码失败时抛出既有稳定错误码
      if (frame === null) break;
      const { oldDone } = await runner.processFrame(frame);
      if (oldDone) break;
    }
    const settled = await decodeResult;
    if (
      !settled.ok &&
      !(runner.oldSongCut && isAbortCode(settled.error?.code))
    ) {
      throw settled.error;
    }
  }

  async function playOneSong({
    channelId,
    receipt,
    ffmpegPath,
    signal,
    sessionBox,
    control,
    carried = null,
  }) {
    const item = receipt.queueItem;

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

    // 旧歌解码专用 Abort：交叉淡化完成后单独切断旧歌尾部，
    // 不影响歌曲级 signal（skip / worker 停止仍走歌曲级）
    const oldDecodeAbort = carried
      ? carried.abortController
      : new AbortController();
    const onSongAbort = () => {
      try {
        oldDecodeAbort.abort();
      } catch {
        // 清理路径失败不影响错误分类
      }
    };
    if (signal.aborted) onSongAbort();
    else signal.addEventListener("abort", onSongAbort, { once: true });

    const runner = createTransitionRunner({
      channelId,
      item,
      control,
      session,
      ffmpegPath,
      abortOldDecode: onSongAbort,
      initialFramesCaptured: carried?.framesAlreadyCaptured ?? 0,
    });
    control.transitionPhase = "playing";

    let handoverResult = null;
    try {
      if (carried) {
        await consumeCarriedFrames({ carried, runner, control, signal });
      } else {
        // 点歌者自己的凭据：A 的歌只能用 A 的 Cookie
        const { cookie } = loadCredential(db, item.principal_key, env);
        const { url } = await neteaseClient.getSongPlaybackUrl({
          songId: item.song_id,
          cookie,
        });
        // URL / Cookie 只在本函数作用域中短暂存在，不写日志、不入库、不回传

        const mediaStream = await openMediaStream(url, {
          signal: oldDecodeAbort.signal,
        });
        const byteLimit = createByteLimit();
        let playbackStarted = false;
        try {
          await decodeToFrames({
            ffmpegPath,
            mediaStream,
            byteLimit,
            signal: oldDecodeAbort.signal,
            env,
            onFrame: async (frame) => {
              await waitWhilePaused(control, signal);
              if (signal.aborted) throw abortPlaybackError();
              if (control.skipRequested) {
                if (runner.isCrossfading()) {
                  runner.requestSkipCut();
                  return;
                }
                throw abortPlaybackError();
              }
              if (runner.oldSongCut) return; // 尾部已切割，丢弃残余帧
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
              await runner.processFrame(frame);
            },
          });
        } catch (error) {
          // 交叉淡化尾部切割触发的 Abort 属于正常完成，不是错误
          if (!(runner.oldSongCut && isAbortCode(error?.code))) throw error;
        }
      }
      if (control.skipRequested && !runner.skipCut) {
        const error = new Error("管理员已切换下一首");
        error.code = "MUSIC_BOT_ADMIN_SKIP";
        throw error;
      }
      handoverResult = await runner.finishOldSong({ signal });
    } finally {
      signal.removeEventListener("abort", onSongAbort);
      if (!handoverResult?.handedOver) {
        runner.cleanup();
        if (carried) {
          try {
            carried.abortController.abort();
          } catch {
            // 清理失败不影响错误分类
          }
          carried.buffer.close();
          // decodeResult 是永不 reject 的已结算对象：等它收尾，
          // 保证离开本函数时不残留仍在退出中的解码任务
          await carried.decodeResult;
        }
      }
    }

    if (handoverResult.handedOver) {
      control.songAbortController = handoverResult.carried.abortController;
      return handoverResult;
    }
    await session.waitForPlayout();
    return { handedOver: false };
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
    let carried = null; // 交接后由下一轮迭代接管的歌曲

    try {
      for (;;) {
        if (stopped || signal.aborted) break;
        if (!carried) {
          // 频道暂时无人时不领取下一首；保留 pending 并等待成员返回。
          // 正在播放的歌曲由 scan 在持续空置达到阈值后 Abort/requeue。
          if (!presenceService.hasUsersInChannel(channelId)) {
            const emptySince = emptySinceByChannel.get(channelId) ?? now();
            emptySinceByChannel.set(channelId, emptySince);
            const remaining = Math.max(0, idlePauseMs - (now() - emptySince));
            if (remaining === 0) break;
            if (!(await abortableDelay(Math.min(scanIntervalMs, remaining), signal))) {
              break;
            }
            continue;
          }
          emptySinceByChannel.delete(channelId);
          if (!hasPendingItems(db, channelId)) break;
        } else {
          // 交接歌曲已经在数据库中为 playing 且解码进行中：
          // 直接继续播放；无人频道的收尾仍由 scan Abort 统一处理
          emptySinceByChannel.delete(channelId);
        }

        let ffmpegPath;
        let receipt;
        if (carried) {
          ffmpegPath = carried.ffmpegPath;
          receipt = carried.receipt;
        } else {
          // 领取之前先探测解码器：失败则不 claim、队列保持 pending、退避
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

          receipt = claimNextQueueItem(db, { channelId });
          if (!receipt) break;
        }

        const activeCarried = carried;
        carried = null;

        control.queueItemId = String(receipt.queueItem.id);
        control.startedAtMs = activeCarried
          ? activeCarried.controlStartedAtMs ?? now()
          : null;
        control.paused = false;
        control.pausedAtMs = null;
        control.totalPausedMs = 0;
        control.skipRequested = false;
        control.transitionPhase = "playing";
        const songAbortController = new AbortController();
        control.songAbortController = songAbortController;
        const abortSong = () => songAbortController.abort();
        if (signal.aborted) abortSong();
        else signal.addEventListener("abort", abortSong, { once: true });

        try {
          const result = await playOneSong({
            channelId,
            receipt,
            ffmpegPath,
            signal: songAbortController.signal,
            sessionBox,
            control,
            carried: activeCarried,
          });
          if (result.handedOver) {
            // 旧歌已在交接事务中 finished/skipped；新歌继续在下一轮播放
            carried = result.carried;
            backoffMs = 0;
            continue;
          }
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
      if (carried) {
        // worker 退出（stop / 无人频道）时尚未接管的交接歌曲：
        // 释放预取解码资源并放回队列原公平位置，绝不丢歌
        try {
          carried.abortController.abort();
        } catch {
          // 清理失败继续释放其余资源
        }
        try {
          carried.buffer.close();
        } catch {
          // 清理失败继续释放其余资源
        }
        // 等待被中止的预取解码完全退出（已结算对象，绝不抛），
        // 保证 stop() resolve 时不残留解码任务
        await carried.decodeResult;
        try {
          requeueClaimedItem(db, {
            queueItemId: carried.receipt.queueItem.id,
            previousLastServedBucketOrder:
              carried.receipt.previousLastServedBucketOrder,
          });
        } catch (error) {
          log("error", "交接歌曲恢复失败", error?.code);
        }
      }
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
    // 无人频道只保留队列，不创建机器人、不领取歌曲。
    if (!presenceService.hasUsersInChannel(channelId)) return;
    emptySinceByChannel.delete(channelId);

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
        emptySinceByChannel.delete(channelId);
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
    if (control.transitionPhase === "crossfading") {
      // DJ 淡化期间：不 Abort、不关会话——播放循环立即切断旧歌，
      // 并在约 300ms 内把新歌平滑拉到 100% 后完成事务交接
      wakePlaybackControl(control);
      return { changed: true, ...getControlSnapshot(control) };
    }
    control.songAbortController?.abort();
    // 立即关闭音频会话以清掉 AudioSource 内最多约 200ms 的残余缓冲；
    // worker 会在 catch 中把当前项标记 skipped，再创建新会话播放下一首。
    await closeSession(worker.sessionBox);
    return { changed: true, ...getControlSnapshot(control) };
  }

  function scan() {
    if (stopped) return;
    try {
      // 活跃频道空置达到阈值后中止当前 worker。当前 playing 项通过既有
      // Abort 错误分类回到 pending 并恢复公平游标；队列不会被清空。
      for (const [channelId, worker] of workers) {
        if (presenceService.hasUsersInChannel(channelId)) {
          emptySinceByChannel.delete(channelId);
          continue;
        }
        const emptySince = emptySinceByChannel.get(channelId) ?? now();
        emptySinceByChannel.set(channelId, emptySince);
        if (now() - emptySince >= idlePauseMs) {
          worker.abortController.abort();
          log("info", "频道持续无人，音乐队列已暂停", "MUSIC_CHANNEL_IDLE");
        }
      }
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
    emptySinceByChannel.clear();
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
