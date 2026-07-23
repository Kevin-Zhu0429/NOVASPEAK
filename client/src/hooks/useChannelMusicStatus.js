import { useCallback, useEffect, useRef, useState } from "react";
import {
  getChannelMusicQueue,
  setChannelDjTransition,
  setChannelMusicPaused,
  skipChannelMusicTrack,
} from "../utils/music-api";
import { getPlaybackProgress } from "../utils/music-format";

const POLL_INTERVAL_MS = 3000;
const CLOCK_INTERVAL_MS = 500;

export default function useChannelMusicStatus({ apiBase, channelId, enabled }) {
  const [snapshot, setSnapshot] = useState(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [controlBusy, setControlBusy] = useState("");
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async ({ signal } = {}) => {
    if (!enabled || !channelId || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await getChannelMusicQueue(apiBase, channelId, { signal });
      if (!mountedRef.current || signal?.aborted) return;
      const receivedAt = Date.now();
      setSnapshot({ ...result, receivedAt });
      setClockMs(receivedAt);
      setError("");
    } catch (loadError) {
      if (!mountedRef.current || loadError?.name === "AbortError") return;
      setError(loadError?.message || "音乐状态暂时不可用");
    } finally {
      inFlightRef.current = false;
    }
  }, [apiBase, channelId, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !channelId) return undefined;
    const controller = new AbortController();
    queueMicrotask(() => refresh({ signal: controller.signal }));
    const pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh({ signal: controller.signal });
    }, POLL_INTERVAL_MS);
    const clockTimer = setInterval(
      () => setClockMs(Date.now()),
      CLOCK_INTERVAL_MS
    );
    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    };
  }, [channelId, enabled, refresh]);

  const nowPlaying = snapshot?.nowPlaying || null;
  const progress = nowPlaying
    ? getPlaybackProgress(nowPlaying.playback, snapshot.receivedAt, clockMs)
    : null;

  const togglePaused = useCallback(async () => {
    if (!nowPlaying || controlBusy) return;
    const paused = nowPlaying.playback?.paused !== true;
    setControlBusy("pause");
    try {
      const result = await setChannelMusicPaused(apiBase, channelId, paused);
      if (!mountedRef.current) return;
      setSnapshot((previous) => previous?.nowPlaying ? {
        ...previous,
        receivedAt: Date.now(),
        nowPlaying: {
          ...previous.nowPlaying,
          playback: {
            ...previous.nowPlaying.playback,
            paused: result.playback?.paused === true,
            elapsedMs: Number(result.playback?.elapsedMs) || 0,
          },
        },
      } : previous);
      setError("");
    } catch (controlError) {
      if (mountedRef.current) {
        setError(controlError?.message || "音乐控制失败");
      }
    } finally {
      if (mountedRef.current) setControlBusy("");
    }
  }, [apiBase, channelId, controlBusy, nowPlaying]);

  const skip = useCallback(async () => {
    if (!nowPlaying || controlBusy) return;
    setControlBusy("skip");
    try {
      await skipChannelMusicTrack(apiBase, channelId);
      if (!mountedRef.current) return;
      setSnapshot((previous) => previous ? {
        ...previous,
        nowPlaying: null,
        receivedAt: Date.now(),
      } : previous);
      setError("");
      queueMicrotask(() => refresh());
    } catch (controlError) {
      if (mountedRef.current) {
        setError(controlError?.message || "切换下一首失败");
      }
    } finally {
      if (mountedRef.current) setControlBusy("");
    }
  }, [apiBase, channelId, controlBusy, nowPlaying, refresh]);

  const djTransitionEnabled = snapshot?.djTransition?.enabled === true;

  const toggleDjTransition = useCallback(async () => {
    if (controlBusy) return;
    const nextEnabled = !djTransitionEnabled;
    setControlBusy("dj");
    try {
      const result = await setChannelDjTransition(apiBase, channelId, nextEnabled);
      if (!mountedRef.current) return;
      setSnapshot((previous) => previous ? {
        ...previous,
        djTransition: {
          ...(previous.djTransition || {}),
          enabled: result.djTransitionEnabled === true,
        },
      } : previous);
      setError("");
    } catch (controlError) {
      if (mountedRef.current) {
        setError(controlError?.message || "切换 DJ 过渡失败");
      }
    } finally {
      if (mountedRef.current) setControlBusy("");
    }
  }, [apiBase, channelId, controlBusy, djTransitionEnabled]);

  return {
    nowPlaying,
    progress,
    error,
    controlBusy,
    canControl: snapshot?.controls?.canControlPlayback === true,
    djTransitionEnabled,
    djTransitionState: snapshot?.djTransition?.transitionState || "idle",
    togglePaused,
    toggleDjTransition,
    skip,
  };
}
