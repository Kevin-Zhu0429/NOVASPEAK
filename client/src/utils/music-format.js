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
