export const VOICE_GATE_STORAGE_KEY = "novaVoiceGate:v1";
export const VOICE_GATE_PROCESSOR_NAME = "nova-voice-gate";
export const MIN_VOICE_GATE_THRESHOLD_DB = -65;
export const MAX_VOICE_GATE_THRESHOLD_DB = -20;
export const DEFAULT_VOICE_GATE_SETTINGS = Object.freeze({
  enabled: false,
  thresholdDb: -45,
});

const GATE_HYSTERESIS_DB = 6;
const GATE_HOLD_MS = 180;
const GATE_SAMPLE_INTERVAL_MS = 20;
const GATE_LOOKAHEAD_SECONDS = 0.04;
const SILENCE_DB = -100;

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function clampVoiceGateThreshold(value) {
  const numeric = typeof value === "boolean" ? NaN : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_VOICE_GATE_SETTINGS.thresholdDb;
  return Math.min(
    MAX_VOICE_GATE_THRESHOLD_DB,
    Math.max(MIN_VOICE_GATE_THRESHOLD_DB, Math.round(numeric))
  );
}

export function normalizeVoiceGateSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled === true,
    thresholdDb: clampVoiceGateThreshold(source.thresholdDb),
  };
}

export function loadVoiceGateSettings(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(VOICE_GATE_STORAGE_KEY);
    return raw
      ? normalizeVoiceGateSettings(JSON.parse(raw))
      : normalizeVoiceGateSettings(null);
  } catch {
    return normalizeVoiceGateSettings(null);
  }
}

export function saveVoiceGateSettings(settings, storage = defaultStorage()) {
  try {
    storage?.setItem?.(
      VOICE_GATE_STORAGE_KEY,
      JSON.stringify(normalizeVoiceGateSettings(settings))
    );
    return true;
  } catch {
    return false;
  }
}

export function rmsToDecibels(rms) {
  const numeric = Number(rms);
  if (!Number.isFinite(numeric) || numeric <= 0) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(numeric));
}

export function calculateRms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

// 纯状态推进：开启阈值与关闭阈值相差 6dB，并在最后一次检测到人声后
// 保持 180ms，避免句尾或短停顿被切碎。
export function advanceVoiceGateState({
  open = false,
  levelDb = SILENCE_DB,
  thresholdDb = DEFAULT_VOICE_GATE_SETTINGS.thresholdDb,
  lastVoiceAtMs = null,
  nowMs = 0,
  holdMs = GATE_HOLD_MS,
  hysteresisDb = GATE_HYSTERESIS_DB,
} = {}) {
  const threshold = clampVoiceGateThreshold(thresholdDb);
  const closeThreshold = threshold - Math.max(0, Number(hysteresisDb) || 0);
  let nextLastVoiceAtMs = lastVoiceAtMs;

  if (levelDb >= threshold || (open && levelDb >= closeThreshold)) {
    nextLastVoiceAtMs = nowMs;
    return { open: true, lastVoiceAtMs: nextLastVoiceAtMs };
  }

  if (
    open &&
    Number.isFinite(nextLastVoiceAtMs) &&
    nowMs - nextLastVoiceAtMs < Math.max(0, Number(holdMs) || 0)
  ) {
    return { open: true, lastVoiceAtMs: nextLastVoiceAtMs };
  }

  return { open: false, lastVoiceAtMs: nextLastVoiceAtMs };
}

function stopTrack(track) {
  try {
    track?.stop?.();
  } catch {
    // 清理失败不应影响语音房间
  }
}

// LiveKit TrackProcessor：原始麦克风 → Analyser → 40ms look-ahead → Gain →
// MediaStreamDestination。低于阈值时只把音频增益拉到 0，不 mute/unmute
// LiveKit publication，因此不会与麦克风按钮或服务器静音互相干扰。
export function createVoiceGateProcessor({
  settings = DEFAULT_VOICE_GATE_SETTINGS,
  onGateStateChange = null,
  now = () => performance.now(),
  setTimer = (callback, ms) => setInterval(callback, ms),
  clearTimer = (timer) => clearInterval(timer),
} = {}) {
  let currentSettings = normalizeVoiceGateSettings(settings);
  let sourceNode = null;
  let analyserNode = null;
  let delayNode = null;
  let gainNode = null;
  let destinationNode = null;
  let sampleBuffer = null;
  let timer = null;
  let gateOpen = false;
  let lastVoiceAtMs = null;
  let audioContext = null;

  const processor = {
    name: VOICE_GATE_PROCESSOR_NAME,
    processedTrack: undefined,

    updateSettings(nextSettings) {
      currentSettings = normalizeVoiceGateSettings(nextSettings);
      if (!currentSettings.enabled) {
        lastVoiceAtMs = null;
        setGateOpen(true, true);
      }
    },

    async init(options) {
      setup(options);
    },

    async restart(options) {
      teardown();
      setup(options);
    },

    async destroy() {
      teardown();
    },
  };

  function applyGain(open, immediate = false) {
    if (!gainNode?.gain || !audioContext) return;
    const value = open || !currentSettings.enabled ? 1 : 0;
    const time = Number(audioContext.currentTime) || 0;
    gainNode.gain.cancelScheduledValues?.(time);
    if (immediate || typeof gainNode.gain.setTargetAtTime !== "function") {
      gainNode.gain.value = value;
      return;
    }
    // 开门快、关门稍慢；look-ahead 可保住开头辅音，缓释可避免句尾硬切。
    gainNode.gain.setTargetAtTime(value, time, open ? 0.006 : 0.05);
  }

  function setGateOpen(next, immediate = false) {
    const normalized = next === true;
    const changed = gateOpen !== normalized;
    gateOpen = normalized;
    applyGain(gateOpen, immediate);
    if (changed) onGateStateChange?.(gateOpen);
  }

  function sampleLevel() {
    if (!analyserNode || !sampleBuffer) return;
    if (!currentSettings.enabled) {
      setGateOpen(true);
      return;
    }
    analyserNode.getFloatTimeDomainData(sampleBuffer);
    const levelDb = rmsToDecibels(calculateRms(sampleBuffer));
    const next = advanceVoiceGateState({
      open: gateOpen,
      levelDb,
      thresholdDb: currentSettings.thresholdDb,
      lastVoiceAtMs,
      nowMs: now(),
    });
    lastVoiceAtMs = next.lastVoiceAtMs;
    setGateOpen(next.open);
  }

  function setup({ track, audioContext: context } = {}) {
    if (!track || !context) throw new Error("当前浏览器无法创建 Voice Gate 音频处理器");
    audioContext = context;
    sourceNode = context.createMediaStreamSource(new MediaStream([track]));
    analyserNode = context.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.15;
    delayNode = context.createDelay(1);
    delayNode.delayTime.value = GATE_LOOKAHEAD_SECONDS;
    gainNode = context.createGain();
    destinationNode = context.createMediaStreamDestination();

    sourceNode.connect(analyserNode);
    analyserNode.connect(delayNode);
    delayNode.connect(gainNode);
    gainNode.connect(destinationNode);

    processor.processedTrack = destinationNode.stream.getAudioTracks()[0];
    if (!processor.processedTrack) throw new Error("Voice Gate 未生成音频轨道");
    try {
      processor.processedTrack.contentHint = "speech";
    } catch {
      // 旧 Chromium 可能不允许设置 contentHint
    }
    sampleBuffer = new Float32Array(analyserNode.fftSize);
    gateOpen = !currentSettings.enabled;
    lastVoiceAtMs = null;
    applyGain(gateOpen, true);
    onGateStateChange?.(gateOpen);
    timer = setTimer(sampleLevel, GATE_SAMPLE_INTERVAL_MS);
  }

  function teardown() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    for (const node of [sourceNode, analyserNode, delayNode, gainNode]) {
      try {
        node?.disconnect?.();
      } catch {
        // 节点可能已经被浏览器断开
      }
    }
    stopTrack(processor.processedTrack);
    processor.processedTrack = undefined;
    sourceNode = null;
    analyserNode = null;
    delayNode = null;
    gainNode = null;
    destinationNode = null;
    sampleBuffer = null;
    audioContext = null;
    gateOpen = false;
    lastVoiceAtMs = null;
    onGateStateChange?.(false);
  }

  return processor;
}
