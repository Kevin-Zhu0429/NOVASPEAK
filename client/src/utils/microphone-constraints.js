export const MIC_CONSTRAINTS_STORAGE_KEY = "novaVoiceMicConstraints:v1";

// 游戏语音场景下自动增益（AGC）容易在没人说话时放大背景音，默认关闭；
// 回声消除 / 噪声抑制默认开启。
export const DEFAULT_MIC_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
});

export const MIC_CONSTRAINT_KEYS = Object.freeze(Object.keys(DEFAULT_MIC_CONSTRAINTS));

// LiveKit Track.Source.Microphone 的字符串值；用字面量避免纯工具依赖 livekit-client。
const MICROPHONE_SOURCE = "microphone";

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function normalizeMicConstraints(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  for (const key of MIC_CONSTRAINT_KEYS) {
    normalized[key] = typeof source[key] === "boolean" ? source[key] : DEFAULT_MIC_CONSTRAINTS[key];
  }
  return normalized;
}

export function sameMicConstraints(a, b) {
  const left = normalizeMicConstraints(a);
  const right = normalizeMicConstraints(b);
  return MIC_CONSTRAINT_KEYS.every((key) => left[key] === right[key]);
}

export function loadMicConstraints(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(MIC_CONSTRAINTS_STORAGE_KEY);
    if (!raw) return normalizeMicConstraints(null);
    return normalizeMicConstraints(JSON.parse(raw));
  } catch {
    return normalizeMicConstraints(null);
  }
}

export function saveMicConstraints(constraints, storage = defaultStorage()) {
  try {
    storage?.setItem?.(MIC_CONSTRAINTS_STORAGE_KEY, JSON.stringify(normalizeMicConstraints(constraints)));
    return true;
  } catch {
    return false;
  }
}

export function setMicConstraint(constraints, key, enabled) {
  const base = normalizeMicConstraints(constraints);
  if (!MIC_CONSTRAINT_KEYS.includes(key)) return base;
  return { ...base, [key]: enabled === true };
}

// Room 构造时的 audioCaptureDefaults 片段，只含三个降噪相关约束。
export function getAudioCaptureDefaults(constraints) {
  return normalizeMicConstraints(constraints);
}

// restartTrack 的参数必须显式带当前 deviceId：livekit 的 constraintsForOptions
// 在缺 deviceId 时会补 { ideal: "default" }，可能把用户手选的麦克风切回系统默认设备。
export function getMicrophoneRestartOptions(constraints, deviceId) {
  const options = normalizeMicConstraints(constraints);
  if (typeof deviceId === "string" && deviceId) options.deviceId = deviceId;
  return options;
}

// 把降噪约束应用到当前 LiveKit 房间：
// 1. 合并进 room.options.audioCaptureDefaults（保留 deviceId 等其余字段），
//    让本次连接里之后新建的麦克风轨道也用新约束；
// 2. 若已有本地麦克风轨道，用 restartTrack 原地重取并替换到同一个 publication。
// 只做这两件事——不调用 setMicrophoneEnabled / mute / unmute，restartTrack 自身
// 保留静音位（enabled = !isMuted），因此不影响服务器静音 / 本地静音 / 麦克风开关。
export async function applyMicConstraintsToRoom(room, constraints) {
  const normalized = normalizeMicConstraints(constraints);
  const localParticipant = room?.localParticipant;
  if (!localParticipant) return { status: "no-room" };
  if (room.state === "disconnected") return { status: "not-connected" };
  if (room.options && typeof room.options === "object") {
    room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, ...normalized };
  }
  const publication = localParticipant.getTrackPublication?.(MICROPHONE_SOURCE);
  const track = publication?.track;
  if (!track || typeof track.restartTrack !== "function") return { status: "no-track" };
  try {
    let deviceId;
    try {
      deviceId = typeof track.getDeviceId === "function" ? await track.getDeviceId(false) : undefined;
    } catch {
      deviceId = undefined;
    }
    if (!deviceId) deviceId = room.getActiveDevice?.("audioinput");
    await track.restartTrack(getMicrophoneRestartOptions(normalized, deviceId));
    return { status: "restarted" };
  } catch (error) {
    return { status: "failed", error };
  }
}
