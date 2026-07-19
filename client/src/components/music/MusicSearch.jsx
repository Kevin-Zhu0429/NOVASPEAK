import { useEffect, useRef, useState } from "react";
import { Music, Plus, Search } from "lucide-react";
import {
  enqueueNeteaseSearchTrack,
  searchNeteaseTracks,
} from "../../utils/music-api";
import { formatArtists, formatTrackDuration } from "../../utils/music-format";

const PAGE_SIZE = 30;

function isSessionInvalidError(error) {
  return (
    error?.code === "NETEASE_SESSION_INVALID" ||
    error?.code === "NETEASE_CREDENTIAL_UNREADABLE"
  );
}

export default function MusicSearch({
  apiBase,
  channelId,
  onSessionInvalid,
}) {
  const [input, setInput] = useState("");
  const [keywords, setKeywords] = useState("");
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [enqueueBusyId, setEnqueueBusyId] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const mountedRef = useRef(true);
  const requestRef = useRef(null);

  useEffect(() => () => {
    mountedRef.current = false;
    requestRef.current?.abort();
  }, []);

  const handleApiError = (apiError, fallback) => {
    if (!mountedRef.current || apiError?.name === "AbortError") return;
    if (isSessionInvalidError(apiError)) {
      onSessionInvalid?.();
      return;
    }
    setError(apiError.message || fallback);
  };

  const runSearch = async (query) => {
    const normalized = query.trim();
    if (!normalized || loading) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setFeedback("");
    try {
      const result = await searchNeteaseTracks(apiBase, normalized, {
        limit: PAGE_SIZE,
        offset: 0,
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      setKeywords(normalized);
      setItems(result.tracks || []);
      setHasMore(result.pagination?.more === true);
    } catch (searchError) {
      handleApiError(searchError, "搜索网易云歌曲失败");
    } finally {
      if (mountedRef.current && requestRef.current === controller) {
        setLoading(false);
      }
    }
  };

  const loadMore = async () => {
    if (!keywords || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await searchNeteaseTracks(apiBase, keywords, {
        limit: PAGE_SIZE,
        offset: items.length,
      });
      if (!mountedRef.current) return;
      setItems((previous) => [...previous, ...(result.tracks || [])]);
      setHasMore(result.pagination?.more === true);
    } catch (searchError) {
      handleApiError(searchError, "加载更多搜索结果失败");
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  const enqueueTrack = async (track) => {
    if (enqueueBusyId || !track.playable) return;
    setEnqueueBusyId(track.id);
    setError("");
    setFeedback("");
    try {
      const result = await enqueueNeteaseSearchTrack(apiBase, channelId, {
        songId: track.id,
      });
      if (!mountedRef.current) return;
      setFeedback(
        result.projectedPosition
          ? `已添加「${track.name}」，预计第 ${result.projectedPosition} 位播放`
          : `已添加「${track.name}」`
      );
    } catch (enqueueError) {
      handleApiError(enqueueError, "点歌失败");
    } finally {
      if (mountedRef.current) setEnqueueBusyId("");
    }
  };

  return (
    <div className="music-search-section">
      <form
        className="music-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch(input);
        }}
      >
        <label htmlFor="netease-music-search">搜索歌曲或歌手</label>
        <span className="music-search-input-row">
          <input
            id="netease-music-search"
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={80}
            placeholder="输入歌曲名或歌手名"
            autoComplete="off"
          />
          <button type="submit" disabled={loading || !input.trim()}>
            <Search />
            {loading ? "搜索中" : "搜索"}
          </button>
        </span>
      </form>

      {feedback && <div className="music-panel-feedback">{feedback}</div>}

      {!keywords && !loading ? (
        <div className="music-panel-empty">搜索网易云歌曲并添加到频道队列</div>
      ) : !loading && items.length === 0 && !error ? (
        <div className="music-panel-empty">没有找到相关歌曲</div>
      ) : (
        <ul className="music-track-list">
          {items.map((track) => (
            <li
              key={track.id}
              className={track.playable ? "music-track" : "music-track music-track-unavailable"}
            >
              <SearchTrackCover picUrl={track.album?.picUrl} unavailable={!track.playable} />
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
                onClick={() => enqueueTrack(track)}
                disabled={!track.playable || Boolean(enqueueBusyId)}
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
          {loadingMore ? "加载中……" : "加载更多结果"}
        </button>
      )}
    </div>
  );
}

function SearchTrackCover({ picUrl, unavailable }) {
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
