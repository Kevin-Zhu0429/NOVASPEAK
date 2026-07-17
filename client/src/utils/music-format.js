// 音乐面板展示用的纯格式化函数。

/**
 * 毫秒时长格式化为 mm:ss，超过 1 小时为 h:mm:ss。
 * 非法输入返回 "--:--"。
 */
export function formatTrackDuration(durationMs) {
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "--:--";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (value) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 歌手数组拼接为展示文本；无有效歌手时返回“未知歌手”。
 */
export function formatArtists(artists) {
  if (!Array.isArray(artists)) return "未知歌手";
  const names = artists
    .map((artist) =>
      typeof artist?.name === "string" && artist.name.trim()
        ? artist.name.trim()
        : null
    )
    .filter(Boolean);
  return names.length > 0 ? names.join("、") : "未知歌手";
}

/**
 * 歌单数量文案。
 */
export function formatTrackCount(trackCount) {
  return typeof trackCount === "number" &&
    Number.isFinite(trackCount) &&
    trackCount >= 0
    ? `${Math.trunc(trackCount)} 首`
    : "";
}

/**
 * 根据服务端快照和本地接收时间平滑推进播放进度。
 * 不依赖客户端与服务端时钟相同，只累计收到快照后的本地时间差。
 */
export function getPlaybackProgress(
  playback,
  receivedAt,
  now = Date.now()
) {
  const durationMs = Number.isFinite(playback?.durationMs)
    ? Math.max(0, playback.durationMs)
    : 0;
  const snapshotElapsedMs = Number.isFinite(playback?.elapsedMs)
    ? Math.max(0, playback.elapsedMs)
    : 0;
  const localDelta = playback?.paused === true
    ? 0
    : Number.isFinite(receivedAt) && Number.isFinite(now)
    ? Math.max(0, now - receivedAt)
    : 0;
  const elapsedMs = Math.min(durationMs, snapshotElapsedMs + localDelta);

  return {
    durationMs,
    elapsedMs,
    percent: durationMs > 0 ? (elapsedMs / durationMs) * 100 : 0,
  };
}
