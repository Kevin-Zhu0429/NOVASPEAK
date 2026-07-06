import { useCallback, useState } from "react";
import { loadLocalAudioPrefs, saveLocalAudioPrefs, setMemberAudioPref } from "../utils/local-audio-preferences";

// 当前用户的本地听音偏好（单成员音量 / 本地静音），只存 localStorage，只影响本机。
export default function useLocalAudioPreferences() {
  const [prefs, setPrefs] = useState(() => loadLocalAudioPrefs());

  const updateMemberPref = useCallback((memberKey, patch) => {
    setPrefs((previous) => {
      const next = setMemberAudioPref(previous, memberKey, patch);
      saveLocalAudioPrefs(next);
      return next;
    });
  }, []);

  const setMemberVolume = useCallback((memberKey, volume) => updateMemberPref(memberKey, { volume }), [updateMemberPref]);
  const setMemberLocalMuted = useCallback((memberKey, muted) => updateMemberPref(memberKey, { muted: muted === true }), [updateMemberPref]);

  return { prefs, setMemberVolume, setMemberLocalMuted };
}
