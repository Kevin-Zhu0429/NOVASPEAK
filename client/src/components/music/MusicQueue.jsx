import { useCallback, useEffect, useRef, useState } from "react";
import { Music, X } from "lucide-react";
import {
  cancelMusicQueueItem,
  getChannelMusicQueue,
} from "../../utils/music-api";
import { formatArtists, formatTrackDuration } from "../../utils/music-format";

const POLL_INTERVAL_MS = 3000;

// 频道共享音乐队列：HTTP polling（3 秒），不新增 WebSocket。
// 未绑定网易云账号也可以查看；请求失败不影响语音频道。
export default function MusicQueue({ apiBase, channelId }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancelBusyId, setCancelBusyId] = useState("");
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(
    async ({ signal } = {}) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const result = await getChannelMusicQueue(apiBase, channelId, { signal });
        if (!mountedRef.current || signal?.aborted) return;
        setSnapshot(result);
        setError("");
      } catch (loadError) {
        if (!mountedRef.current || loadError?.name === "AbortError") return;
        // 显示错误，但下一轮 polling 仍允许恢复
        setError(loadError.message || "获取频道队列失败");
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [apiBase, channelId]
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    queueMicrotask(() => refresh({ signal: controller.signal }));

    const timer = setInterval(() => {
      // 页面不可见时暂停轮询；防止请求重叠由 inFlightRef 保证
      if (typeof document !== "undefined" && document.hidden) return;
      refresh({ signal: controller.signal });
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  const cancelItem = async (item) => {
    if (cancelBusyId) return;
    setCancelBusyId(item.id);
    setError("");
    try {
      await cancelMusicQueueItem(apiBase, channelId, item.id);
      if (!mountedRef.current) return;
      // 取消后立即刷新，不等下一轮 polling
      await refresh();
    } catch (cancelError) {
      if (mountedRef.current) {
        setError(cancelError.message || "取消歌曲失败");
      }
    } finally {
      if (mountedRef.current) setCancelBusyId("");
    }
  };

  if (loading) {
    return <div className="music-panel-loading">正在加载频道队列……</div>;
  }

  const items = snapshot?.items || [];
  const nowPlaying = snapshot?.nowPlaying || null;

  return (
    <div className="music-queue-section">
      {nowPlaying && (
        <div className="music-queue-now-playing">
          <QueueCover picUrl={nowPlaying.song.album?.picUrl} />
          <span className="music-track-main">
            <span className="music-queue-now-label">音乐机器人正在播放</span>
            <strong className="music-track-name">{nowPlaying.song.name}</strong>
            <span className="music-track-meta">
              {formatArtists(nowPlaying.song.artists)} ·{" "}
              {nowPlaying.requester.displayName}
              {nowPlaying.requester.isCurrentUser ? "（我）" : ""} 点歌
            </span>
          </span>
        </div>
      )}

      {items.length === 0 && !nowPlaying && !error ? (
        <div className="music-panel-empty">频道队列还是空的</div>
      ) : items.length === 0 ? null : (
        <ul className="music-queue-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={
                item.requester.isCurrentUser
                  ? "music-queue-item music-queue-item-mine"
                  : "music-queue-item"
              }
            >
              <span className="music-queue-position">
                {item.projectedPosition}
              </span>
              <QueueCover picUrl={item.song.album?.picUrl} />
              <span className="music-track-main">
                <strong className="music-track-name">{item.song.name}</strong>
                <span className="music-track-meta">
                  {formatArtists(item.song.artists)} ·{" "}
                  {formatTrackDuration(item.song.durationMs)}
                </span>
                <span className="music-queue-requester">
                  {item.requester.displayName}
                  {item.requester.isCurrentUser ? "（我）" : ""} 点歌
                </span>
              </span>
              {item.canCancel && (
                <button
                  type="button"
                  className="music-queue-cancel-button"
                  onClick={() => cancelItem(item)}
                  disabled={Boolean(cancelBusyId)}
                  aria-label={`取消 ${item.song.name}`}
                  title="取消这首歌"
                >
                  <X />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <div className="music-panel-error">{error}</div>}
    </div>
  );
}

function QueueCover({ picUrl }) {
  const [failed, setFailed] = useState(false);
  if (!picUrl || failed) {
    return (
      <span
        className="music-cover music-cover-small music-cover-fallback"
        aria-hidden="true"
      >
        <Music />
      </span>
    );
  }
  return (
    <img
      className="music-cover music-cover-small"
      src={picUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
