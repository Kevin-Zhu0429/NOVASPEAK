import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_GATE_PROCESSOR_NAME,
  createVoiceGateProcessor,
  loadVoiceGateSettings,
  normalizeVoiceGateSettings,
  saveVoiceGateSettings,
} from "../utils/voice-gate";

function microphoneTrack(room) {
  return room?.localParticipant?.getTrackPublication?.("microphone")?.track ?? null;
}

async function stopOwnedProcessor(track, processor) {
  if (!track || track.getProcessor?.() !== processor) return;
  await track.stopProcessor?.();
}

// Voice Gate 只处理本地麦克风轨道，不 mute/unmute publication，不调用后端。
// 应用操作串行执行，避免启用/禁用、切麦克风和 restartTrack 交叉。
export default function useVoiceGate(room, microphoneEnabled) {
  const [settings, setSettings] = useState(() => loadVoiceGateSettings());
  const [gateOpen, setGateOpen] = useState(false);
  const [applyError, setApplyError] = useState("");
  const activeTrackRef = useRef(null);
  const queueRef = useRef(Promise.resolve());
  const [processor] = useState(() =>
    createVoiceGateProcessor({
      settings,
      onGateStateChange: setGateOpen,
    })
  );

  useEffect(() => {
    processor.updateSettings(settings);
  }, [processor, settings]);

  useEffect(() => {
    let stale = false;
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (stale) return;
        const track = microphoneTrack(room);
        const previousTrack = activeTrackRef.current;

        if (previousTrack && previousTrack !== track) {
          await stopOwnedProcessor(previousTrack, processor);
          if (activeTrackRef.current === previousTrack) activeTrackRef.current = null;
        }

        if (!settings.enabled || !microphoneEnabled || !track) {
          await stopOwnedProcessor(track ?? previousTrack, processor);
          if (!stale) {
            activeTrackRef.current = null;
            setGateOpen(false);
            setApplyError("");
          }
          return;
        }

        const existing = track.getProcessor?.();
        if (existing && existing !== processor) {
          if (!stale) setApplyError("当前麦克风正在使用其他音频处理器，无法同时启用 Voice Gate");
          return;
        }
        if (!existing) await track.setProcessor(processor, false);
        if (!stale) {
          activeTrackRef.current = track;
          setApplyError("");
        }
      })
      .catch((error) => {
        console.error("应用 Voice Gate 失败：", error);
        if (!stale) setApplyError("无法应用 Voice Gate，请关闭后重试或重新进入频道");
      });
    return () => {
      stale = true;
    };
  }, [processor, room, microphoneEnabled, settings.enabled]);

  useEffect(() => () => {
    const track = activeTrackRef.current;
    activeTrackRef.current = null;
    if (track?.getProcessor?.()?.name === VOICE_GATE_PROCESSOR_NAME) {
      track.stopProcessor?.().catch?.(() => undefined);
    }
  }, [processor]);

  const setEnabled = useCallback((enabled) => {
    setSettings((previous) => {
      const next = normalizeVoiceGateSettings({ ...previous, enabled: enabled === true });
      saveVoiceGateSettings(next);
      return next;
    });
  }, []);

  const setThresholdDb = useCallback((thresholdDb) => {
    setSettings((previous) => {
      const next = normalizeVoiceGateSettings({ ...previous, thresholdDb });
      saveVoiceGateSettings(next);
      return next;
    });
  }, []);

  return {
    settings,
    gateOpen,
    applyError,
    setEnabled,
    setThresholdDb,
  };
}
