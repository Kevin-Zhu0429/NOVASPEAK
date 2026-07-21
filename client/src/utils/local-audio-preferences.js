export const LOCAL_AUDIO_PREFS_STORAGE_KEY = "novaVoiceLocalAudioPrefs:v1";
export const DEFAULT_MEMBER_VOLUME = 100;
export const DEFAULT_MUSIC_BOT_VOLUME = 10;
export const MUSIC_BOT_AUDIO_KEY = "music-bot:global";
export const MIN_MEMBER_VOLUME = 0;
export const MAX_MEMBER_VOLUME = 200;

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function clampMemberVolume(value) {
  const numeric = typeof value === "boolean" ? NaN : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MEMBER_VOLUME;
  return Math.min(MAX_MEMBER_VOLUME, Math.max(MIN_MEMBER_VOLUME, Math.round(numeric)));
}

export function normalizeMemberAudioPref(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { volume: clampMemberVolume(source.volume), muted: source.muted === true };
}

export function isMusicBotAudioKey(memberKey) {
  return typeof memberKey === "string" && memberKey.startsWith("music-bot:");
}

function getAudioPreferenceStorageKey(memberKey) {
  if (typeof memberKey !== "string") return "";
  const trimmed = memberKey.trim();
  if (!trimmed) return "";
  return isMusicBotAudioKey(trimmed) ? MUSIC_BOT_AUDIO_KEY : trimmed;
}

// 旧版本按频道保存 music-bot:<channelId>。升级时合并成一个全局机器人偏好；
// 多个旧值冲突时保留更安静的音量和静音状态，避免切换频道突然变响。
function mergeMusicBotAudioPref(current, incoming) {
  if (!current) return incoming;
  return {
    volume: Math.min(current.volume, incoming.volume),
    muted: current.muted || incoming.muted,
  };
}

export function getDefaultMemberVolume(memberKey) {
  return isMusicBotAudioKey(memberKey)
    ? DEFAULT_MUSIC_BOT_VOLUME
    : DEFAULT_MEMBER_VOLUME;
}

// 稳定 member key：identity 形如 "<公开成员ID>:voice:<连接ID>"，取公开成员 ID 部分；
// Guest 的公开 ID 本身就是 "guest:UUID"，无 ":voice:" 后缀时用整个 identity 兜底。
export function getMemberAudioKey(itemOrIdentity) {
  const identity = typeof itemOrIdentity === "string" ? itemOrIdentity : itemOrIdentity?.id;
  if (typeof identity !== "string") return "";
  const trimmed = identity.trim();
  if (!trimmed) return "";
  if (isMusicBotAudioKey(trimmed)) return MUSIC_BOT_AUDIO_KEY;
  const marker = trimmed.indexOf(":voice:");
  return marker > 0 ? trimmed.slice(0, marker) : trimmed;
}

export function loadLocalAudioPrefs(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(LOCAL_AUDIO_PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const prefs = {};
    for (const [key, value] of Object.entries(parsed)) {
      const storageKey = getAudioPreferenceStorageKey(key);
      if (!storageKey) continue;
      const pref = normalizeMemberAudioPref(value);
      prefs[storageKey] = storageKey === MUSIC_BOT_AUDIO_KEY
        ? mergeMusicBotAudioPref(prefs[storageKey], pref)
        : pref;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function saveLocalAudioPrefs(prefs, storage = defaultStorage()) {
  try {
    const source = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
    const safe = {};
    for (const [key, value] of Object.entries(source)) {
      const storageKey = getAudioPreferenceStorageKey(key);
      if (!storageKey) continue;
      const pref = normalizeMemberAudioPref(value);
      safe[storageKey] = storageKey === MUSIC_BOT_AUDIO_KEY
        ? mergeMusicBotAudioPref(safe[storageKey], pref)
        : pref;
    }
    storage?.setItem?.(LOCAL_AUDIO_PREFS_STORAGE_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function getMemberAudioPref(prefs, memberKey) {
  const fallback = { volume: getDefaultMemberVolume(memberKey), muted: false };
  const storageKey = getAudioPreferenceStorageKey(memberKey);
  if (!storageKey || !prefs || typeof prefs !== "object") return fallback;
  if (Object.prototype.hasOwnProperty.call(prefs, storageKey)) {
    return normalizeMemberAudioPref(prefs[storageKey]);
  }
  if (storageKey === MUSIC_BOT_AUDIO_KEY) {
    let migrated = null;
    for (const [key, value] of Object.entries(prefs)) {
      if (isMusicBotAudioKey(key)) {
        migrated = mergeMusicBotAudioPref(migrated, normalizeMemberAudioPref(value));
      }
    }
    if (migrated) return migrated;
  }
  return fallback;
}

export function setMemberAudioPref(prefs, memberKey, patch) {
  const base = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  const storageKey = getAudioPreferenceStorageKey(memberKey);
  if (!storageKey) return base;
  const current = getMemberAudioPref(base, storageKey);
  const source = patch && typeof patch === "object" ? patch : {};
  const next = {};
  for (const [key, value] of Object.entries(base)) {
    if (storageKey === MUSIC_BOT_AUDIO_KEY && isMusicBotAudioKey(key)) continue;
    next[key] = value;
  }
  next[storageKey] = normalizeMemberAudioPref({ ...current, ...source });
  return next;
}

// 有效音量（倍率）：Deafen 或本地静音 → 0，否则 volume / 100（0 ～ 2）。
export function getEffectiveVolume({ deafened = false, localMuted = false, volume = DEFAULT_MEMBER_VOLUME } = {}) {
  if (deafened === true || localMuted === true) return 0;
  return clampMemberVolume(volume) / 100;
}

// 应用到 audio 元素的补丁：muted 只归 Deafen 管，本地静音/音量走 volume；
// HTMLMediaElement.volume 标准范围 0 ～ 1，超过 100% 的部分 clamp 到 1。
export function getAudioElementPatch({ deafened = false, localMuted = false, volume = DEFAULT_MEMBER_VOLUME } = {}) {
  return {
    muted: deafened === true,
    volume: Math.min(1, localMuted === true ? 0 : clampMemberVolume(volume) / 100),
  };
}

// LiveKit webAudioMix 会把远端音轨接入 Web Audio GainNode，允许真实超过
// HTMLMediaElement 100% 上限。Web Audio 模式下原始 <audio> 必须保持 muted，
// 实际听音音量交给 participant/track.setVolume（0 ～ 2）。不支持时安全降级。
//
// elementVolume 必须为 0：LiveKit 的 Room.startAudio()（本地麦克风
// AudioStreamAcquired 后 SDK 自动触发）会把所有远端 audio 元素强制
// muted=false，若元素 volume 不为 0，原生播放路径会以该音量与 GainNode
// 路径同时出声，产生满音量叠音/梳状滤波电音。
export function getRemoteAudioPlaybackPlan({
  deafened = false,
  localMuted = false,
  volume = DEFAULT_MEMBER_VOLUME,
  webAudioEnabled = false,
} = {}) {
  const effectiveVolume = getEffectiveVolume({ deafened, localMuted, volume });
  if (webAudioEnabled) {
    return {
      elementMuted: true,
      elementVolume: 0,
      trackVolume: effectiveVolume,
    };
  }
  const fallback = getAudioElementPatch({ deafened, localMuted, volume });
  return {
    elementMuted: fallback.muted,
    elementVolume: fallback.volume,
    trackVolume: null,
  };
}

// RemoteParticipant 会把每种 Track.Source 的音量保存在 volumeMap 中，并在
// LiveKit 因重连/切换频道而替换 RemoteAudioTrack 时自动应用到新音轨。
// 必须在 track.attach() 前写入，避免新 GainNode 先以默认 100% 开始播放。
export function applyRemoteParticipantVolumePreference({
  participant,
  source,
  deafened = false,
  localMuted = false,
  volume = DEFAULT_MEMBER_VOLUME,
} = {}) {
  if (typeof participant?.setVolume !== "function") return false;
  try {
    participant.setVolume(
      getEffectiveVolume({ deafened, localMuted, volume }),
      source
    );
    return true;
  } catch {
    return false;
  }
}

// RemoteAudioTrack.setVolume 只调用 gain.setTargetAtTime(target, 0, 0.1)，
// 而新建 GainNode 的初始增益是 1.0——低音量目标（如机器人 10%）在音轨
// 挂载/重建后会有约半秒从 100% 指数衰减的高音量残留。这里在应用偏好后
// 把增益立即钉到目标值；gainNode 是 SDK 内部字段，全程特性检测，
// 不可用时静默回退到原有 setTargetAtTime 行为（不会更糟）。
export function snapRemoteAudioTrackGain(track, volume) {
  try {
    const gain = track?.gainNode?.gain;
    if (
      !gain ||
      typeof gain.cancelScheduledValues !== "function" ||
      typeof gain.setValueAtTime !== "function" ||
      !Number.isFinite(volume)
    ) {
      return false;
    }
    const currentTime = track?.audioContext?.currentTime;
    const now = Number.isFinite(currentTime) ? currentTime : 0;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(volume, now);
    return true;
  } catch {
    return false;
  }
}

// 把同一份本地偏好同时应用到 LiveKit RemoteAudioTrack 与回退 audio 元素。
// 返回本次是否实际启用了 Web Audio，供调用方在音轨重新创建或播放恢复后
// 重新探测并再次应用，避免滑块显示旧值但新音轨仍使用默认增益。
export function applyRemoteAudioPlaybackPreference({
  track,
  participant,
  source,
  element,
  deafened = false,
  localMuted = false,
  volume = DEFAULT_MEMBER_VOLUME,
  webAudioEnabled = false,
} = {}) {
  let activeWebAudio = webAudioEnabled === true && typeof track?.setVolume === "function";
  let plan = getRemoteAudioPlaybackPlan({
    deafened,
    localMuted,
    volume,
    webAudioEnabled: activeWebAudio,
  });

  applyRemoteParticipantVolumePreference({
    participant,
    source,
    deafened,
    localMuted,
    volume,
  });

  // participant.setVolume 负责让后续替换音轨继承偏好；这里仍直接确认当前
  // track，避免 SDK 尚未把 publication/source 关联完成时漏掉正在播放的音轨。
  if (activeWebAudio) {
    try {
      track.setVolume(plan.trackVolume);
      snapRemoteAudioTrackGain(track, plan.trackVolume);
    } catch {
      activeWebAudio = false;
      plan = getRemoteAudioPlaybackPlan({
        deafened,
        localMuted,
        volume,
        webAudioEnabled: false,
      });
    }
  }

  if (element) {
    element.muted = plan.elementMuted;
    element.volume = plan.elementVolume;
  }

  return { webAudioEnabled: activeWebAudio, plan };
}
