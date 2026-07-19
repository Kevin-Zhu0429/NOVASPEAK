export const LOCAL_AUDIO_PREFS_STORAGE_KEY = "novaVoiceLocalAudioPrefs:v1";
export const DEFAULT_MEMBER_VOLUME = 100;
export const DEFAULT_MUSIC_BOT_VOLUME = 50;
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
      if (typeof key === "string" && key) prefs[key] = normalizeMemberAudioPref(value);
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
      if (typeof key === "string" && key) safe[key] = normalizeMemberAudioPref(value);
    }
    storage?.setItem?.(LOCAL_AUDIO_PREFS_STORAGE_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function getMemberAudioPref(prefs, memberKey) {
  const fallback = { volume: getDefaultMemberVolume(memberKey), muted: false };
  if (!memberKey || !prefs || typeof prefs !== "object") return fallback;
  if (!Object.prototype.hasOwnProperty.call(prefs, memberKey)) return fallback;
  return normalizeMemberAudioPref(prefs[memberKey]);
}

export function setMemberAudioPref(prefs, memberKey, patch) {
  const base = prefs && typeof prefs === "object" && !Array.isArray(prefs) ? prefs : {};
  if (!memberKey || typeof memberKey !== "string") return base;
  const current = getMemberAudioPref(base, memberKey);
  const source = patch && typeof patch === "object" ? patch : {};
  return { ...base, [memberKey]: normalizeMemberAudioPref({ ...current, ...source }) };
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
// 实际听音音量全部交给 track.setVolume（0 ～ 2）。不支持 Web Audio 时安全降级。
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
      elementVolume: 1,
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
