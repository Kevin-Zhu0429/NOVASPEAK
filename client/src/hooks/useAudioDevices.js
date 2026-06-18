import { useCallback, useEffect, useState } from "react";

export default function useAudioDevices(enabled) {
  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [error, setError] = useState("");
  const outputSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("当前浏览器无法读取音频设备");
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputs(devices.filter((device) => device.kind === "audioinput"));
      setOutputs(devices.filter((device) => device.kind === "audiooutput"));
      setError("");
    } catch (deviceError) {
      console.error("读取音频设备失败：", deviceError);
      setError("无法读取音频设备");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    queueMicrotask(refresh);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [enabled, refresh]);

  return { inputs, outputs, outputSupported, refresh, error };
}
