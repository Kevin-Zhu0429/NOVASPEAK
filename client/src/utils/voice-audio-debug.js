import { isMusicBotAudioKey } from "./local-audio-preferences.js";

// 仅开发诊断（localStorage novaVoiceDebug === "1" 时启用，与 VoiceRoom 的
// voiceLifecycleDebug 共用同一开关）。快照只包含 AGENTS.md 允许的白名单
// 字段：attemptId / channelId / trackSid / 机器人标记 / attach 与 element
// 数量 / AudioContext state / muted / volume / gain / 时间。
// 绝不读取或输出 token、Cookie、播放 URL、用户敏感 metadata。

export const VOICE_AUDIO_SNAPSHOT_FIELDS = Object.freeze([
  "attemptId",
  "channelId",
  "trackSid",
  "isMusicBot",
  "attachedElementCount",
  "audioElementCount",
  "musicBotOutletCount",
  "webAudioEnabled",
  "audioContextState",
  "elementMuted",
  "elementVolume",
  "gainValue",
  "timestampMs",
]);

// 同一 Room 内 music-bot 身份的音频出口数量；> 1 说明同一机器人同时
// 存在多个可发声出口（重复 publication 或未清理的旧音轨）。
export function countMusicBotOutlets(entries) {
  let count = 0;
  if (!entries) return count;
  for (const entry of entries) {
    if (isMusicBotAudioKey(entry?.participantIdentity)) count += 1;
  }
  return count;
}

export function buildAudioChainSnapshot({
  attemptId = null,
  channelId = "",
  trackSid = "",
  entry = null,
  entries = null,
  audioElementCount = null,
  room = null,
  now = Date.now,
} = {}) {
  const track = entry?.track;
  const element = entry?.element;
  const audioContext = room?.audioContext;
  const gainValue = track?.gainNode?.gain?.value;
  return {
    attemptId,
    channelId: typeof channelId === "string" ? channelId : "",
    trackSid: typeof trackSid === "string" ? trackSid : "",
    isMusicBot: isMusicBotAudioKey(entry?.participantIdentity),
    attachedElementCount: Array.isArray(track?.attachedElements)
      ? track.attachedElements.length
      : null,
    audioElementCount: Number.isFinite(audioElementCount) ? audioElementCount : null,
    musicBotOutletCount: entries ? countMusicBotOutlets(entries) : null,
    webAudioEnabled: entry?.webAudioEnabled === true,
    audioContextState: typeof audioContext?.state === "string" ? audioContext.state : null,
    elementMuted: typeof element?.muted === "boolean" ? element.muted : null,
    elementVolume: Number.isFinite(element?.volume) ? element.volume : null,
    gainValue: Number.isFinite(gainValue) ? gainValue : null,
    timestampMs: typeof now === "function" ? now() : null,
  };
}
