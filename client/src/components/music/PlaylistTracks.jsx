import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ListMusic, ListPlus, Music, Plus } from "lucide-react";
import {
  enqueueNeteasePlaylist,
  enqueueNeteaseTrack,
  getNeteasePlaylistTracks,
} from "../../utils/music-api";
import { formatArtists, formatTrackDuration } from "../../utils/music-format";

const PAGE_SIZE = 50;

function isSessionInvalidError(error) {
  return (
    error?.code === "NETEASE_SESSION_INVALID" ||
    error?.code === "NETEASE_CREDENTIAL_UNREADABLE"
  );
}

// 单个歌单的歌曲列表（分页 + 点歌）。
// 点歌只提交 playlistId/songId/绝对 trackIndex，元数据由服务端决定。
export default function PlaylistTracks({ apiBase, channelId, playlist, onBack, onSessionInvalid }) {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [coverFailed, setCoverFailed] = useState(false);
  const [enqueueBusyId, setEnqueueBusyId] = useState("");
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    (async () => {
      try {
        const result = await getNeteasePlaylistTracks(apiBase, playlist.id, {
          limit: PAGE_SIZE,
          offset: 0,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems(result.tracks || []);
        setHasMore(result.pagination?.more === true);
        setError("");
      } catch (loadError) {
        if (loadError?.name === "AbortError") return;
        if (isSessionInvalidError(loadError)) {
          onSessionInvalid?.();
          return;
        }
        setError(loadError.message || "获取歌单歌曲失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, playlist.id]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await getNeteasePlaylistTracks(apiBase, playlist.id, {
        limit: PAGE_SIZE,
        offset: items.length,
      });
      if (!mountedRef.current) return;
      setItems((previous) => [...previous, ...(result.tracks || [])]);
      setHasMore(result.pagination?.more === true);
    } catch (loadError) {
      if (!mountedRef.current || loadError?.name === "AbortError") return;
      if (isSessionInvalidError(loadError)) {
        onSessionInvalid?.();
        return;
      }
      setError(loadError.message || "获取歌单歌曲失败");
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  // trackIndex 是 items 数组中的绝对位置（分页从 offset 0 顺序累加）
  const enqueueTrack = async (track, trackIndex) => {
    if (enqueueBusyId || !track.playable) return;
    setEnqueueBusyId(track.id);
    setError("");
    setFeedback("");
    try {
      const result = await enqueueNeteaseTrack(apiBase, channelId, {
        playlistId: playlist.id,
        songId: track.id,
        trackIndex,
      });
      if (!mountedRef.current) return;
      setFeedback(
        result.projectedPosition
          ? `已添加「${track.name}」，预计第 ${result.projectedPosition} 位播放`
          : `已添加「${track.name}」`
      );
    } catch (enqueueError) {
      if (!mountedRef.current) return;
      if (isSessionInvalidError(enqueueError)) {
        onSessionInvalid?.();
        return;
      }
      setError(enqueueError.message || "点歌失败");
    } finally {
      if (mountedRef.current) setEnqueueBusyId("");
    }
  };

  const enqueuePlaylist = async () => {
    if (playlistBusy) return;
    setPlaylistBusy(true);
    setError("");
    setFeedback("");
    try {
      const result = await enqueueNeteasePlaylist(apiBase, channelId, {
        playlistId: playlist.id,
      });
      if (!mountedRef.current) return;
      const parts = [`已添加 ${result.addedCount} 首`];
      if (result.skippedUnavailableCount > 0) {
        parts.push(`跳过 ${result.skippedUnavailableCount} 首不可用歌曲`);
      }
      if (result.truncated) {
        parts.push("因队列上限截断");
      }
      setFeedback(parts.join("，"));
    } catch (enqueueError) {
      if (!mountedRef.current) return;
      if (isSessionInvalidError(enqueueError)) {
        onSessionInvalid?.();
        return;
      }
      setError(enqueueError.message || "添加歌单失败");
    } finally {
      if (mountedRef.current) setPlaylistBusy(false);
    }
  };

  return (
    <div className="music-tracks-section">
      <div className="music-tracks-header">
        <button
          type="button"
          className="music-back-button"
          onClick={onBack}
          aria-label="返回歌单列表"
        >
          <ArrowLeft />
        </button>
        {playlist.coverImgUrl && !coverFailed ? (
          <img
            className="music-cover music-cover-small"
            src={playlist.coverImgUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <span className="music-cover music-cover-small music-cover-fallback" aria-hidden="true">
            <ListMusic />
          </span>
        )}
        <strong className="music-tracks-title">{playlist.name}</strong>
        <button
          type="button"
          className="music-enqueue-playlist-button"
          onClick={enqueuePlaylist}
          disabled={playlistBusy || loading}
          aria-label="添加整个歌单到频道队列"
        >
          <ListPlus />
          {playlistBusy ? "添加中……" : "添加整个歌单"}
        </button>
      </div>

      {feedback && <div className="music-panel-feedback">{feedback}</div>}

      {loading ? (
        <div className="music-panel-loading">正在加载歌曲……</div>
      ) : items.length === 0 && !error ? (
        <div className="music-panel-empty">这个歌单还没有歌曲</div>
      ) : (
        <ul className="music-track-list">
          {items.map((track, index) => (
            <li
              key={track.id}
              className={track.playable ? "music-track" : "music-track music-track-unavailable"}
            >
              <TrackCover picUrl={track.album?.picUrl} unavailable={!track.playable} />
              <span className="music-track-main">
                <strong className="music-track-name">{track.name}</strong>
                <span className="music-track-meta">
                  {formatArtists(track.artists)}
                  {track.album?.name ? ` · ${track.album.name}` : ""}
                </span>
                {!track.playable && track.unavailableReason && (
                  <span className="music-track-reason">{track.unavailableReason}</span>
                )}
              </span>
              <span className="music-track-duration">
                {formatTrackDuration(track.durationMs)}
              </span>
              <button
                type="button"
                className="music-enqueue-button"
                onClick={() => enqueueTrack(track, index)}
                disabled={!track.playable || Boolean(enqueueBusyId)}
                aria-label={`点歌 ${track.name}`}
                title={track.playable ? "添加到频道队列" : track.unavailableReason || "不可用"}
              >
                <Plus />
                {enqueueBusyId === track.id ? "添加中" : "点歌"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="music-panel-error">{error}</div>}

      {hasMore && !loading && (
        <button
          type="button"
          className="music-load-more"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "加载中……" : "加载更多歌曲"}
        </button>
      )}
    </div>
  );
}

function TrackCover({ picUrl, unavailable }) {
  const [failed, setFailed] = useState(false);
  const className = unavailable
    ? "music-cover music-cover-small music-track-cover-dim"
    : "music-cover music-cover-small";
  if (!picUrl || failed) {
    return (
      <span className={`${className} music-cover-fallback`} aria-hidden="true">
        <Music />
      </span>
    );
  }
  return (
    <img
      className={className}
      src={picUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
