import { useEffect, useRef, useState } from "react";
import { ListMusic } from "lucide-react";
import { getNeteasePlaylists } from "../../utils/music-api";
import { formatTrackCount } from "../../utils/music-format";

const PAGE_SIZE = 30;

function isSessionInvalidError(error) {
  return (
    error?.code === "NETEASE_SESSION_INVALID" ||
    error?.code === "NETEASE_CREDENTIAL_UNREADABLE"
  );
}

// 当前用户的网易云歌单列表（分页）。
export default function PlaylistList({ apiBase, onSelectPlaylist, onSessionInvalid }) {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();

    (async () => {
      try {
        const result = await getNeteasePlaylists(apiBase, {
          limit: PAGE_SIZE,
          offset: 0,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems(result.playlists || []);
        setHasMore(result.pagination?.more === true);
        setError("");
      } catch (loadError) {
        if (loadError?.name === "AbortError") return;
        if (isSessionInvalidError(loadError)) {
          onSessionInvalid?.();
          return;
        }
        setError(loadError.message || "获取网易云歌单失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
    // onSessionInvalid 由父组件保证稳定；此处只随 apiBase 重载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await getNeteasePlaylists(apiBase, {
        limit: PAGE_SIZE,
        offset: items.length,
      });
      if (!mountedRef.current) return;
      setItems((previous) => [...previous, ...(result.playlists || [])]);
      setHasMore(result.pagination?.more === true);
    } catch (loadError) {
      if (!mountedRef.current || loadError?.name === "AbortError") return;
      if (isSessionInvalidError(loadError)) {
        onSessionInvalid?.();
        return;
      }
      setError(loadError.message || "获取网易云歌单失败");
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  if (loading) {
    return <div className="music-panel-loading">正在加载歌单……</div>;
  }

  return (
    <div className="music-playlist-section">
      {items.length === 0 && !error ? (
        <div className="music-panel-empty">这个网易云账号还没有歌单</div>
      ) : (
        <ul className="music-playlist-list">
          {items.map((playlist) => (
            <li key={playlist.id}>
              <button
                type="button"
                className="music-playlist-item"
                onClick={() => onSelectPlaylist?.(playlist)}
                aria-label={`打开歌单 ${playlist.name}`}
              >
                <PlaylistCover coverImgUrl={playlist.coverImgUrl} />
                <span className="music-playlist-info">
                  <strong>{playlist.name}</strong>
                  <span className="music-playlist-meta">
                    <span className={playlist.subscribed ? "music-tag music-tag-subscribed" : "music-tag"}>
                      {playlist.subscribed ? "收藏" : "自建"}
                    </span>
                    {formatTrackCount(playlist.trackCount)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="music-panel-error">{error}</div>}

      {hasMore && (
        <button
          type="button"
          className="music-load-more"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "加载中……" : "加载更多歌单"}
        </button>
      )}
    </div>
  );
}

function PlaylistCover({ coverImgUrl }) {
  const [failed, setFailed] = useState(false);
  if (!coverImgUrl || failed) {
    return (
      <span className="music-cover music-cover-fallback" aria-hidden="true">
        <ListMusic />
      </span>
    );
  }
  return (
    <img
      className="music-cover"
      src={coverImgUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
