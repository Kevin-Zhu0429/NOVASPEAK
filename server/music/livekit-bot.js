// LiveKit 音乐机器人（6A 阶段：仅测试音推流验证）。
//
// 约束：
// - @livekit/rtc-node 懒加载（动态 import）：普通 Express 启动绝不加载原生 RTC 模块；
// - 机器人不加入现有 VoiceRoom 生命周期，也不使用任何 WebSocket；
// - token 由现有 livekit-server-sdk 生成，只授予目标频道的发布权限；
// - 本模块不调用全局 dispose()——那只属于一次性 probe CLI 进程退出前；
// - 不打印 LIVEKIT_API_SECRET、token 或其他凭据。

import { AccessToken } from "livekit-server-sdk";
import { createTestTone } from "./test-tone.js";

export const MUSIC_BOT_ERROR = Object.freeze({
  RTC_UNAVAILABLE: "LIVEKIT_RTC_UNAVAILABLE",
  NOT_CONFIGURED: "LIVEKIT_NOT_CONFIGURED",
  CONNECT_FAILED: "MUSIC_BOT_CONNECT_FAILED",
  PUBLISH_FAILED: "MUSIC_BOT_PUBLISH_FAILED",
});

export class MusicBotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MusicBotError";
    this.code = code;
  }
}

export const MUSIC_BOT_NAME = "音乐机器人";

// 同一频道固定 identity，避免重复机器人长期残留
export function getMusicBotIdentity(channelId) {
  return `music-bot:${channelId}`;
}

function readLiveKitEnv(env) {
  const url = env?.LIVEKIT_URL?.trim();
  const apiKey = env?.LIVEKIT_API_KEY?.trim();
  const apiSecret = env?.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) {
    throw new MusicBotError(
      MUSIC_BOT_ERROR.NOT_CONFIGURED,
      "缺少 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 配置"
    );
  }
  return { url, apiKey, apiSecret };
}

/**
 * 生成机器人 AccessToken：只能加入指定频道，只允许发布音频，
 * 不允许订阅、不允许发数据、无任何管理权限。
 */
export async function buildMusicBotToken(channelId, env = process.env) {
  const { apiKey, apiSecret } = readLiveKitEnv(env);

  const token = new AccessToken(apiKey, apiSecret, {
    identity: getMusicBotIdentity(channelId),
    name: MUSIC_BOT_NAME,
    metadata: JSON.stringify({
      displayName: MUSIC_BOT_NAME,
      isMusicBot: true,
    }),
  });

  token.addGrant({
    room: channelId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
  });

  return token.toJwt();
}

async function defaultLoadRtc() {
  return import("@livekit/rtc-node");
}

/**
 * 让音乐机器人加入指定频道并播放一段本地生成的低音量测试音。
 * 全部依赖可注入（rtc 模块、token、测试音、时钟），便于用 mock 单测。
 *
 * 正常与异常路径都必须清理 AudioSource、Track、Room；
 * signal（AbortSignal）中止时安全提前结束。
 */
export async function playTestToneInChannel({
  channelId,
  durationSeconds,
  env = process.env,
  loadRtc = defaultLoadRtc,
  token = null,
  tone = null,
  signal = null,
  onStatus = () => {},
} = {}) {
  if (typeof channelId !== "string" || !channelId.trim()) {
    throw new MusicBotError(
      MUSIC_BOT_ERROR.NOT_CONFIGURED,
      "缺少有效的 channelId"
    );
  }

  const { url } = readLiveKitEnv(env);
  const activeTone = tone || createTestTone({ durationSeconds });
  const botToken = token || (await buildMusicBotToken(channelId, env));

  let rtc;
  try {
    rtc = await loadRtc();
  } catch {
    // 不透出原生模块加载细节，避免异常信息夹带环境路径
    throw new MusicBotError(
      MUSIC_BOT_ERROR.RTC_UNAVAILABLE,
      "无法加载 @livekit/rtc-node 原生模块"
    );
  }

  const room = new rtc.Room();
  let source = null;
  let publication = null;
  let aborted = false;
  let framesSent = 0;

  // 清理必须逐步兜底：任何一步失败都不能阻止后续清理
  async function cleanup() {
    if (publication && room.localParticipant) {
      try {
        await room.localParticipant.unpublishTrack(publication.sid, true);
      } catch {
        // 忽略清理失败，继续释放其余资源
      }
      publication = null;
    }
    if (source) {
      try {
        await source.close();
      } catch {
        // 忽略清理失败
      }
      source = null;
    }
    try {
      await room.disconnect();
    } catch {
      // 忽略清理失败
    }
  }

  try {
    onStatus("connecting");
    try {
      await room.connect(url, botToken, { autoSubscribe: false });
    } catch {
      throw new MusicBotError(
        MUSIC_BOT_ERROR.CONNECT_FAILED,
        "连接 LiveKit 频道失败"
      );
    }
    onStatus("connected");

    try {
      // 200ms 内部队列：captureFrame 满队列时自然按实时节奏阻塞
      source = new rtc.AudioSource(
        activeTone.sampleRate,
        activeTone.channels,
        200
      );
      const track = rtc.LocalAudioTrack.createAudioTrack(
        "music-bot-test-tone",
        source
      );
      const publishOptions = new rtc.TrackPublishOptions({
        source: rtc.TrackSource.SOURCE_MICROPHONE,
      });
      publication = await room.localParticipant.publishTrack(
        track,
        publishOptions
      );
    } catch {
      throw new MusicBotError(
        MUSIC_BOT_ERROR.PUBLISH_FAILED,
        "发布测试音轨失败"
      );
    }
    onStatus("published");

    for (let index = 0; index < activeTone.totalFrames; index += 1) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      const samples = activeTone.frameAt(index);
      const frame = new rtc.AudioFrame(
        samples,
        activeTone.sampleRate,
        activeTone.channels,
        activeTone.samplesPerFrame
      );
      await source.captureFrame(frame);
      framesSent += 1;
    }

    if (!aborted) {
      // 播放完队列中剩余音频后再停止
      await source.waitForPlayout();
    }

    onStatus(aborted ? "aborted" : "completed");
  } finally {
    await cleanup();
    onStatus("disconnected");
  }

  return {
    aborted,
    framesSent,
    totalFrames: activeTone.totalFrames,
    identity: getMusicBotIdentity(channelId),
  };
}

export function createMusicBotAudioSession({ channelId, env = process.env, loadRtc = defaultLoadRtc, token = null } = {}) {
  if (typeof channelId !== "string" || !channelId.trim()) {
    throw new MusicBotError(MUSIC_BOT_ERROR.NOT_CONFIGURED, "缺少有效的 channelId");
  }
  const identity = getMusicBotIdentity(channelId);
  let room = null;
  let source = null;
  let publication = null;
  let rtc = null;
  let connected = false;
  let closing = false;
  async function cleanup() {
    if (publication && room?.localParticipant) {
      try { await room.localParticipant.unpublishTrack(publication.sid, true); } catch {}
      publication = null;
    }
    if (source) { try { await source.close(); } catch {} source = null; }
    if (room) { try { await room.disconnect(); } catch {} room = null; }
    connected = false;
  }
  return {
    identity,
    async connect() {
      if (connected) return;
      const { url } = readLiveKitEnv(env);
      const botToken = token || (await buildMusicBotToken(channelId, env));
      try { rtc = await loadRtc(); } catch { throw new MusicBotError(MUSIC_BOT_ERROR.RTC_UNAVAILABLE, "无法加载 @livekit/rtc-node 原生模块"); }
      room = new rtc.Room();
      try { await room.connect(url, botToken, { autoSubscribe: false }); }
      catch { throw new MusicBotError(MUSIC_BOT_ERROR.CONNECT_FAILED, "连接 LiveKit 频道失败"); }
      try {
        source = new rtc.AudioSource(48000, 1, 200);
        const track = rtc.LocalAudioTrack.createAudioTrack("music-bot-audio", source);
        const publishOptions = new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE });
        publication = await room.localParticipant.publishTrack(track, publishOptions);
      } catch { await cleanup(); throw new MusicBotError(MUSIC_BOT_ERROR.PUBLISH_FAILED, "发布音乐音轨失败"); }
      connected = true;
    },
    async capturePcmFrame(samples) {
      if (!connected || !source || !rtc) throw new MusicBotError(MUSIC_BOT_ERROR.PUBLISH_FAILED, "音乐机器人未连接");
      const frame = new rtc.AudioFrame(samples, 48000, 1, 480);
      await source.captureFrame(frame);
    },
    async waitForPlayout() { if (source) await source.waitForPlayout(); },
    async close() { if (closing) return; closing = true; await cleanup(); },
  };
}
