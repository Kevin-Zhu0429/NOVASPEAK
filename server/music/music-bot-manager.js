import { decryptMusicCredential, MUSIC_NOT_CONFIGURED } from "./credential-store.js";
import { getNeteaseAccountRow } from "./account-service.js";
import { NETEASE_ERROR, NeteaseError } from "./netease-client.js";
import { claimNextQueueItem, finishQueueItem, listPendingMusicChannelIds, recoverInterruptedQueueItems, requeuePlayingQueueItem } from "./music-queue.js";
import { openNeteaseMediaStream, MediaSourceError } from "./playback-source.js";
import { decodeMediaStreamToPcmFrames, FFMPEG_ERROR, FfmpegDecodeError } from "./ffmpeg-decoder.js";
import { createMusicBotAudioSession, MusicBotError } from "./livekit-bot.js";

const INFRA_CODES = new Set([FFMPEG_ERROR.NOT_FOUND, "LIVEKIT_RTC_UNAVAILABLE", "LIVEKIT_NOT_CONFIGURED", "MUSIC_BOT_CONNECT_FAILED", "MUSIC_BOT_PUBLISH_FAILED"]);
const SKIP_CODES = new Set([NETEASE_ERROR.PLAYBACK_SESSION_INVALID, NETEASE_ERROR.PLAYBACK_URL_UNAVAILABLE, NETEASE_ERROR.PLAYBACK_TRIAL_ONLY, NETEASE_ERROR.RATE_LIMITED, "NETEASE_ACCOUNT_NOT_BOUND", "NETEASE_CREDENTIAL_UNREADABLE"]);

export function createMusicBotManager({ db, neteaseClient, presenceService, env = process.env, logger = console, createSession = createMusicBotAudioSession, mediaOpener = openNeteaseMediaStream, decoder = decodeMediaStreamToPcmFrames, scanIntervalMs = 10_000 } = {}) {
  const workers = new Map();
  const backoff = new Map();
  let stopped = false;
  let timer = null;
  const controllers = new Set();

  function codeOf(error) { return error?.code || "MUSIC_BOT_UNKNOWN_ERROR"; }
  function noteInfra(channelId, code) {
    const prev = backoff.get(channelId)?.delay || 2500;
    const delay = Math.min(Math.max(prev * 2, 5000), 60_000);
    backoff.set(channelId, { retryAt: Date.now() + delay, delay });
    logger.warn?.(`Music bot channel worker paused: ${code}`);
  }
  function canStart(channelId) {
    const b = backoff.get(channelId);
    return !b || Date.now() >= b.retryAt;
  }
  async function loadCookie(principalKey) {
    const row = getNeteaseAccountRow(db, principalKey);
    if (!row) { const e = new Error("网易云账号未绑定"); e.code = "NETEASE_ACCOUNT_NOT_BOUND"; throw e; }
    try { return decryptMusicCredential({ ciphertext: row.encrypted_cookie, iv: row.cookie_iv, authTag: row.cookie_auth_tag }, env); }
    catch (error) { if (error?.code === MUSIC_NOT_CONFIGURED) throw error; const e = new Error("网易云凭据不可读"); e.code = "NETEASE_CREDENTIAL_UNREADABLE"; throw e; }
  }
  async function playItem(channelId, item, session, signal) {
    let cookie = await loadCookie(item.principal_key);
    const playback = await neteaseClient.getSongPlaybackUrl({ songId: item.song_id, cookie, level: "standard" });
    cookie = null;
    const { stream } = await mediaOpener({ url: playback.url, signal });
    await decoder({ mediaStream: stream, ffmpegPath: env.FFMPEG_PATH || "ffmpeg", signal, onFrame: (frame) => session.capturePcmFrame(frame) });
    await session.waitForPlayout();
  }
  async function run(channelId) {
    const controller = new AbortController(); controllers.add(controller);
    let session = null;
    try {
      while (!stopped && !controller.signal.aborted) {
        if (!presenceService?.hasUsersInChannel?.(channelId)) break;
        const item = claimNextQueueItem(db, { channelId });
        if (!item) break;
        try {
          if (!session) { session = createSession({ channelId, env }); await session.connect(); }
          await playItem(channelId, item, session, controller.signal);
          finishQueueItem(db, { queueItemId: item.id, outcome: "finished" });
          backoff.delete(channelId);
        } catch (error) {
          const code = codeOf(error);
          if (INFRA_CODES.has(code) || error instanceof MusicBotError || code === MUSIC_NOT_CONFIGURED) {
            requeuePlayingQueueItem(db, { queueItemId: item.id }); noteInfra(channelId, code); break;
          }
          const outcome = SKIP_CODES.has(code) || error instanceof NeteaseError ? "skipped" : "failed";
          finishQueueItem(db, { queueItemId: item.id, outcome, failureCode: code });
          logger.warn?.(`Music bot item ended: ${code}`);
        }
      }
    } catch (error) { logger.warn?.(`Music bot channel worker stopped: ${codeOf(error)}`); }
    finally { try { await session?.close?.(); } catch {} controllers.delete(controller); workers.delete(channelId); }
  }
  function kick(channelId) {
    if (stopped || typeof channelId !== "string" || !channelId || workers.has(channelId) || !canStart(channelId)) return false;
    const promise = run(channelId).catch((error) => logger.warn?.(`Music bot worker failed: ${codeOf(error)}`));
    workers.set(channelId, promise); return true;
  }
  function scan() { try { for (const channelId of listPendingMusicChannelIds(db)) kick(channelId); } catch (error) { logger.warn?.(`Music bot scan failed: ${codeOf(error)}`); } }
  return {
    kick,
    start() { if (timer || stopped) return; scan(); timer = setInterval(scan, scanIntervalMs); timer.unref?.(); },
    recoverInterrupted() { return recoverInterruptedQueueItems(db); },
    async stop() { stopped = true; if (timer) clearInterval(timer); for (const c of controllers) c.abort(); await Promise.allSettled([...workers.values()]); workers.clear(); },
    _workers: workers,
    _scan: scan,
  };
}
