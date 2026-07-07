import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAnnouncementSpeaker,
  isAnnouncementsEnabled,
  parseAnnouncementMessage,
  setAnnouncementsEnabled,
} from "../utils/voice-announcements";

// 语音播报：接收 Presence WS 的 announcement 消息，经队列顺序朗读。
// 浏览器自动播放限制：首次 pointerdown/keydown 交互后解锁，未解锁前的事件丢弃。
export default function useVoiceAnnouncements(active) {
  const [enabled, setEnabledState] = useState(() => isAnnouncementsEnabled());
  const enabledRef = useRef(enabled);
  const speakerRef = useRef(null);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!active) return undefined;
    const speaker = createAnnouncementSpeaker({ isEnabled: () => enabledRef.current });
    speakerRef.current = speaker;
    const unlock = () => speaker.setUnlocked(true);
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      speaker.dispose();
      if (speakerRef.current === speaker) speakerRef.current = null;
    };
  }, [active]);

  const handleAnnouncement = useCallback((raw) => {
    const event = parseAnnouncementMessage(raw);
    if (event) speakerRef.current?.enqueue(event);
  }, []);

  const setEnabled = useCallback((value) => {
    const next = value === true;
    setAnnouncementsEnabled(next);
    setEnabledState(next);
  }, []);

  return { enabled, setEnabled, handleAnnouncement };
}
