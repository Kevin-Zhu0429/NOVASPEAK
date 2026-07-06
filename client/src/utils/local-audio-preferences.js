export const LOCAL_AUDIO_PREFS_STORAGE_KEY = "novaVoiceLocalAudioPrefs:v1";
export const DEFAULT_LOCAL_VOLUME = 100;
export const MIN_LOCAL_VOLUME = 0;
export const MAX_LOCAL_VOLUME = 200;

export function clampLocalVolume(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LOCAL_VOLUME;
  return Math.min(MAX_LOCAL_VOLUME, Math.max(MIN_LOCAL_VOLUME, Math.round(value)));
}

export function normalizeLocalAudioPreference(value) {
  return {
    volume: clampLocalVolume(value?.volume),
    muted: typeof value?.muted === "boolean" ? value.muted : false,
  };
}

export function getLocalAudioMemberKey(participantOrItem = {}) {
  const metadata = participantOrItem.metadata && typeof participantOrItem.metadata === "string"
    ? safeParseMetadata(participantOrItem.metadata)
    : participantOrItem;
  const stableId = metadata.publicMemberId || metadata.memberId || metadata.userId || metadata.id;
  if (typeof stableId === "string" && stableId.trim() && !stableId.startsWith("db:")) return stableId.trim();
  const identity = participantOrItem.identity || participantOrItem.participantIdentity || participantOrItem.id;
  if (typeof identity === "string" && identity.trim()) return identity.trim();
  return "unknown-participant";
}

function safeParseMetadata(metadata) {
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readLocalAudioPreferences(storage = globalThis.localStorage) {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_AUDIO_PREFS_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, normalizeLocalAudioPreference(value)]));
  } catch {
    return {};
  }
}

export function getLocalAudioPreference(memberKey, storage = globalThis.localStorage) {
  return normalizeLocalAudioPreference(readLocalAudioPreferences(storage)[memberKey]);
}

export function writeLocalAudioPreference(memberKey, patch, storage = globalThis.localStorage) {
  if (!storage || typeof memberKey !== "string" || !memberKey.trim()) return normalizeLocalAudioPreference(patch);
  const preferences = readLocalAudioPreferences(storage);
  const next = normalizeLocalAudioPreference({ ...preferences[memberKey], ...patch });
  preferences[memberKey] = next;
  storage.setItem(LOCAL_AUDIO_PREFS_STORAGE_KEY, JSON.stringify(preferences));
  return next;
}

export function getEffectiveAudioVolume({ volume = DEFAULT_LOCAL_VOLUME, muted = false, deafened = false } = {}) {
  if (muted === true || deafened === true) return 0;
  return clampLocalVolume(volume) / 100;
}

export function getAudioElementPatch(preference, { deafened = false } = {}) {
  const effectiveVolume = getEffectiveAudioVolume({ ...normalizeLocalAudioPreference(preference), deafened });
  return {
    muted: effectiveVolume === 0,
    volume: Math.min(1, effectiveVolume),
    requestedVolume: effectiveVolume,
  };
}
