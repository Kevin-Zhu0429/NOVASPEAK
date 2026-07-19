import { useCallback, useEffect, useRef, useState } from "react";
import { Music, Pin, Shuffle, Trash2, X } from "lucide-react";
import {
  cancelOwnPendingMusicQueue,
  cancelMusicQueueItem,
  clearChannelMusicQueue,
  getChannelMusicQueue,
  prioritizeChannelMusicQueueItem,
  shuffleChannelMusicQueue,
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
  const [queueActionBusy, setQueueActionBusy] = useState("");
  const [feedback, setFeedback] = useState("");
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

  const shuffleQueue = async () => {
    if (queueActionBusy) return;
    setQueueActionBusy("shuffle");
    setError("");
    try {
      await shuffleChannelMusicQueue(apiBase, channelId);
      if (mountedRef.current) await refresh();
    } catch (shuffleError) {
      if (mountedRef.current) {
        setError(shuffleError.message || "随机排序失败");
      }
    } finally {
      if (mountedRef.current) setQueueActionBusy("");
    }
  };

  const removeOwnPending = async () => {
    if (queueActionBusy || !window.confirm("删除你在当前频道排队的全部歌曲？")) return;
    setQueueActionBusy("remove-own");
    setError("");
    setFeedback("");
    try {
      const result = await cancelOwnPendingMusicQueue(apiBase, channelId);
      if (!mountedRef.current) return;
      setFeedback(`已删除 ${result.cancelledCount || 0} 首自己排队的歌曲`);
      await refresh();
    } catch (removeError) {
      if (mountedRef.current) {
        setError(removeError.message || "删除自己的排队歌曲失败");
      }
    } finally {
      if (mountedRef.current) setQueueActionBusy("");
    }
  };

  const clearQueue = async () => {
    if (queueActionBusy || !window.confirm("清空当前频道的全部待播放歌曲？正在播放的歌曲会继续。")) return;
    setQueueActionBusy("clear");
    setError("");
    setFeedback("");
    try {
      const result = await clearChannelMusicQueue(apiBase, channelId);
      if (!mountedRef.current) return;
      setFeedback(`已清空 ${result.cancelledCount || 0} 首待播放歌曲`);
      await refresh();
    } catch (clearError) {
      if (mountedRef.current) {
        setError(clearError.message || "清空频道队列失败");
      }
    } finally {
      if (mountedRef.current) setQueueActionBusy("");
    }
  };

  const prioritizeItem = async (item) => {
    if (queueActionBusy) return;
    setQueueActionBusy(`prioritize:${item.id}`);
    setError("");
    try {
      await prioritizeChannelMusicQueueItem(apiBase, channelId, item.id);
      if (mountedRef.current) await refresh();
    } catch (prioritizeError) {
      if (mountedRef.current) {
        setError(prioritizeError.message || "设置优先播放失败");
      }
    } finally {
      if (mountedRef.current) setQueueActionBusy("");
    }
  };

  if (loading) {
    return <div className="music-panel-loading">正在加载频道队列……</div>;
  }

  const items = snapshot?.items || [];
  const nowPlaying = snapshot?.nowPlaying || null;
  const canControlQueue = snapshot?.controls?.canControlPlayback === true;
  const canClearQueue = snapshot?.controls?.canClearQueue === true;
  const hasOwnPending = snapshot?.controls?.hasOwnPending === true;

  return (
    <div className="music-queue-section">
      <div className="music-queue-toolbar">
        <span className="music-queue-summary">
          待播放 {items.length} 首
          <small>随机播放仍保留用户交替顺序</small>
        </span>
        <span className="music-queue-toolbar-actions">
          {hasOwnPending && (
            <button
              type="button"
              className="music-queue-danger-button"
              onClick={removeOwnPending}
              disabled={Boolean(queueActionBusy)}
            >
              <Trash2 />
              删除我的
            </button>
          )}
          {canClearQueue && items.length > 0 && (
            <button
              type="button"
              className="music-queue-danger-button"
              onClick={clearQueue}
              disabled={Boolean(queueActionBusy)}
            >
              <Trash2 />
              清空队列
            </button>
          )}
          {canControlQueue && (
            <button
              type="button"
              className="music-queue-shuffle-button"
              onClick={shuffleQueue}
              disabled={Boolean(queueActionBusy) || items.length < 2}
              title="打乱每位用户各自歌曲的顺序，用户之间仍公平交替"
            >
              <Shuffle />
              随机播放
            </button>
          )}
        </span>
      </div>

      {feedback && <div className="music-panel-feedback">{feedback}</div>}

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
                {item.prioritized && (
                  <span className="music-queue-priority-tag">下一首优先</span>
                )}
                <span className="music-track-meta">
                  {formatArtists(item.song.artists)} ·{" "}
                  {formatTrackDuration(item.song.durationMs)}
                </span>
                <span className="music-queue-requester">
                  {item.requester.displayName}
                  {item.requester.isCurrentUser ? "（我）" : ""} 点歌
                </span>
              </span>
              <span className="music-queue-item-actions">
                {canControlQueue && !item.prioritized && (
                  <button
                    type="button"
                    className="music-queue-prioritize-button"
                    onClick={() => prioritizeItem(item)}
                    disabled={Boolean(queueActionBusy)}
                    aria-label={`优先播放 ${item.song.name}`}
                    title="设为下一首播放"
                  >
                    <Pin />
                  </button>
                )}
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
              </span>
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
