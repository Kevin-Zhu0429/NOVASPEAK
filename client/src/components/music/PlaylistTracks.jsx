import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ListMusic } from "lucide-react";
import { getNeteasePlaylistTracks } from "../../utils/music-api";
import { formatArtists, formatTrackDuration } from "../../utils/music-format";

const PAGE_SIZE = 50;

function isSessionInvalidError(error) {
  return (
    error?.code === "NETEASE_SESSION_INVALID" ||
    error?.code === "NETEASE_CREDENTIAL_UNREADABLE"
  );
}

// 单个歌单的歌曲列表（分页）。
export default function PlaylistTracks({ apiBase, playlist, onBack, onSessionInvalid }) {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [coverFailed, setCoverFailed] = useState(false);
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
      </div>

      {loading ? (
        <div className="music-panel-loading">正在加载歌曲……</div>
      ) : items.length === 0 && !error ? (
        <div className="music-panel-empty">这个歌单还没有歌曲</div>
      ) : (
        <ul className="music-track-list">
          {items.map((track) => (
            <li
              key={track.id}
              className={track.playable ? "music-track" : "music-track music-track-unavailable"}
            >
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
