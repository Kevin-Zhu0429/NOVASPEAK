import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Music } from "lucide-react";
import { getChannelMusicQueue } from "../../utils/music-api";
import {
  buildNeteaseSongUrl,
  formatArtists,
  formatTrackDuration,
  getPlaybackProgress,
} from "../../utils/music-format";

const POLL_INTERVAL_MS = 3000;
const CLOCK_INTERVAL_MS = 500;

// 频道共享音乐状态区。继续复用现有队列 HTTP 接口，不新增 WebSocket；
// 不获取、不保存、不转发歌词文本，只提供网易云官方歌曲页入口。
export default function ChannelMusicStage({ apiBase, channelId }) {
  const [snapshot, setSnapshot] = useState(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(
    async ({ signal } = {}) => {
      if (inFlightRef.current) return;
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
    },
    [apiBase, channelId]
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    queueMicrotask(() => refresh({ signal: controller.signal }));
    const pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh({ signal: controller.signal });
    }, POLL_INTERVAL_MS);
    const clockTimer = setInterval(() => setClockMs(Date.now()), CLOCK_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      controller.abort();
      clearInterval(pollTimer);
      clearInterval(clockTimer);
    };
  }, [refresh]);

  const nowPlaying = snapshot?.nowPlaying || null;
  if (!nowPlaying) {
    return (
      <section className="channel-music-stage channel-music-stage-idle">
        <span className="channel-music-stage-icon" aria-hidden="true"><Music /></span>
        <span>
          <strong>音乐机器人空闲</strong>
          <small>{error || "打开右下角“网易云音乐”即可点歌"}</small>
        </span>
      </section>
    );
  }

  const progress = getPlaybackProgress(
    nowPlaying.playback,
    snapshot.receivedAt,
    clockMs
  );
  const songUrl = buildNeteaseSongUrl(nowPlaying.song.id);

  return (
    <section className="channel-music-stage" aria-label="频道正在播放">
      <div className="channel-music-stage-main">
        <StageCover key={nowPlaying.song.id} picUrl={nowPlaying.song.album?.picUrl} />
        <span className="channel-music-stage-copy">
          <span className="channel-music-stage-eyebrow">频道正在播放</span>
          <strong title={nowPlaying.song.name}>{nowPlaying.song.name}</strong>
          <span>{formatArtists(nowPlaying.song.artists)}</span>
          <small>
            {nowPlaying.requester.displayName}
            {nowPlaying.requester.isCurrentUser ? "（我）" : ""} 点歌
          </small>
        </span>
        {songUrl && (
          <a
            className="channel-music-official-link"
            href={songUrl}
            target="_blank"
            rel="noreferrer noopener"
            title="在网易云官方页面查看歌曲和歌词"
          >
            <ExternalLink />
            <span>网易云查看</span>
          </a>
        )}
      </div>
      <div className="channel-music-progress-row">
        <div
          className="channel-music-progress"
          role="progressbar"
          aria-label="歌曲播放进度"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(progress.percent)}
        >
          <span style={{ width: `${progress.percent}%` }} />
        </div>
        <span className="channel-music-time">
          {formatTrackDuration(progress.elapsedMs)} / {formatTrackDuration(progress.durationMs)}
        </span>
      </div>
      <p className="channel-music-copyright-note">
        歌词请在网易云官方页面查看
      </p>
    </section>
  );
}

function StageCover({ picUrl }) {
  const [failed, setFailed] = useState(false);
  if (!picUrl || failed) {
    return <span className="channel-music-cover channel-music-cover-fallback" aria-hidden="true"><Music /></span>;
  }
  return (
    <img
      className="channel-music-cover"
      src={picUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
