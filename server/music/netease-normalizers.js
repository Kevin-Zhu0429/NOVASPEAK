// 网易云第三方数据标准化：全部为纯函数，可直接单元测试。
// 原则：
// - 所有 ID 对外统一为十进制字符串，避免 JS 大整数精度问题；
// - 图片 URL 只保留 http(s)，其他一律置 null；
// - 绝不把第三方原始对象直接透传给前端；
// - playable 只是列表提示，不是播放授权，下一阶段取 URL 时必须再校验。

const HTTP_URL_PATTERN = /^https?:\/\//;

const PLAYLIST_ID_PATTERN = /^\d{1,20}$/;

/**
 * 任意 ID（number / string）转十进制字符串；无效返回 null。
 */
export function toIdString(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

export function isValidPlaylistId(value) {
  return typeof value === "string" && PLAYLIST_ID_PATTERN.test(value);
}

function safeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeHttpUrl(value) {
  return typeof value === "string" && HTTP_URL_PATTERN.test(value)
    ? value
    : null;
}

function safeCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * 校验分页参数。limit/offset 未提供时取默认值；
 * 非整数、越界一律拒绝。
 */
export function parsePageParams(
  query,
  { defaultLimit, maxLimit, maxOffset = 10000 }
) {
  const parseValue = (raw, fallback) => {
    if (raw === undefined || raw === null || raw === "") return fallback;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return NaN;
    return Number(text);
  };

  const limit = parseValue(query?.limit, defaultLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    return { ok: false, error: `limit 必须是 1～${maxLimit} 的整数` };
  }

  const offset = parseValue(query?.offset, 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > maxOffset) {
    return { ok: false, error: `offset 必须是 0～${maxOffset} 的整数` };
  }

  return { ok: true, limit, offset };
}

/**
 * user_playlist 单个歌单标准化。缺少有效 id 时返回 null（该条被丢弃）。
 */
export function normalizePlaylist(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = toIdString(raw.id);
  if (!id) return null;

  const creatorId = toIdString(raw.creator?.userId ?? raw.userId);

  return {
    id,
    name: safeText(raw.name) || "未命名歌单",
    coverImgUrl: safeHttpUrl(raw.coverImgUrl),
    trackCount: safeCount(raw.trackCount) ?? 0,
    playCount: safeCount(raw.playCount),
    subscribed: raw.subscribed === true,
    creator: {
      userId: creatorId,
      nickname: safeText(raw.creator?.nickname),
    },
  };
}

/**
 * 歌曲可用性提示（非播放授权）：
 * - privilege.st < 0：版权/地区不可用；
 * - privilege.pl > 0：当前账号可播放；
 * - privilege.pl === 0：当前账号无播放权限；
 * - 无 privilege 时按歌曲自身 st / noCopyrightRcmd 判断；
 * - 无法确定时不声称可播放。
 */
export function getTrackAvailability(song, privilege) {
  if (privilege && typeof privilege === "object") {
    const st = Number(privilege.st ?? 0);
    const pl = Number(privilege.pl ?? 0);
    if (Number.isFinite(st) && st < 0) {
      return { playable: false, unavailableReason: "因版权或地区限制不可用" };
    }
    if (Number.isFinite(pl) && pl > 0) {
      return { playable: true, unavailableReason: null };
    }
    return { playable: false, unavailableReason: "当前账号暂无播放权限" };
  }

  const songSt = Number(song?.st ?? 0);
  if (Number.isFinite(songSt) && songSt < 0) {
    return { playable: false, unavailableReason: "因版权或地区限制不可用" };
  }
  if (song?.noCopyrightRcmd) {
    return { playable: false, unavailableReason: "因版权或地区限制不可用" };
  }
  return { playable: false, unavailableReason: "歌曲可用性未知" };
}

/**
 * song_detail 单曲标准化（privilege 为同 id 的权限对象，可缺省）。
 * 缺少有效 id 时返回 null。
 */
export function normalizeTrack(raw, privilege) {
  if (!raw || typeof raw !== "object") return null;
  const id = toIdString(raw.id);
  if (!id) return null;

  const artists = Array.isArray(raw.ar)
    ? raw.ar
        .map((artist) => {
          const artistId = toIdString(artist?.id);
          const name = safeText(artist?.name);
          if (!name) return null;
          return { id: artistId, name };
        })
        .filter(Boolean)
    : [];

  let album = null;
  if (raw.al && typeof raw.al === "object") {
    const albumName = safeText(raw.al.name);
    if (albumName) {
      album = {
        id: toIdString(raw.al.id),
        name: albumName,
        picUrl: safeHttpUrl(raw.al.picUrl),
      };
    }
  }

  const durationMs =
    typeof raw.dt === "number" && Number.isFinite(raw.dt) && raw.dt > 0
      ? Math.trunc(raw.dt)
      : 0;

  const fee =
    typeof raw.fee === "number" && Number.isFinite(raw.fee)
      ? Math.trunc(raw.fee)
      : 0;

  const availability = getTrackAvailability(raw, privilege);

  return {
    id,
    name: safeText(raw.name) || "未知歌曲",
    artists,
    album,
    durationMs,
    fee,
    playable: availability.playable,
    unavailableReason: availability.unavailableReason,
  };
}
