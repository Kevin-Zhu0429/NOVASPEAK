// 歌单浏览服务层。
// 身份铁律：principalKey 只能来自 req.authUser；网易云 uid 只能来自
// 当前用户数据库记录中的 netease_user_id，绝不使用前端传入的 uid。
// 解密后的 Cookie 只作为 netease-client 调用参数存在于本模块内存中：
// 不写日志、不写响应、不重新保存明文。

import {
  MUSIC_NOT_CONFIGURED,
  decryptMusicCredential,
} from "./credential-store.js";
import { getNeteaseAccountRow } from "./account-service.js";
import { normalizePlaylist, normalizeTrack, toIdString } from "./netease-normalizers.js";

export const MUSIC_LIBRARY_ERROR = Object.freeze({
  NOT_BOUND: "NETEASE_ACCOUNT_NOT_BOUND",
  CREDENTIAL_UNREADABLE: "NETEASE_CREDENTIAL_UNREADABLE",
  PLAYLIST_NOT_FOUND: "NETEASE_PLAYLIST_NOT_FOUND",
  TRACK_NOT_FOUND: "MUSIC_TRACK_NOT_FOUND",
  TRACK_UNAVAILABLE: "MUSIC_TRACK_UNAVAILABLE",
});

export class MusicLibraryError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "MusicLibraryError";
    this.code = code;
    this.status = status;
  }
}

// 歌单归属验证的有界分页扫描
const OWNERSHIP_SCAN_PAGE_SIZE = 100;
const OWNERSHIP_SCAN_MAX_PAGES = 20;

/**
 * 读取并解密当前用户自己的网易云凭据。
 * 未绑定（含 guest 凭据已过期被清理）→ NETEASE_ACCOUNT_NOT_BOUND(409)；
 * 解密失败 → 稳定错误，不透出 crypto 异常，不自动删除绑定记录。
 */
export function loadNeteaseCredential(db, principalKey, env = process.env) {
  const row = getNeteaseAccountRow(db, principalKey);
  if (!row) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.NOT_BOUND,
      "请先绑定网易云账号",
      409
    );
  }

  let cookie;
  try {
    cookie = decryptMusicCredential(
      {
        ciphertext: row.encrypted_cookie,
        iv: row.cookie_iv,
        authTag: row.cookie_auth_tag,
      },
      env
    );
  } catch (error) {
    if (error?.code === MUSIC_NOT_CONFIGURED) throw error;
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.CREDENTIAL_UNREADABLE,
      "网易云登录信息无法读取，请重新登录网易云",
      401
    );
  }

  const neteaseUserId = toIdString(row.netease_user_id);
  if (!neteaseUserId) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.CREDENTIAL_UNREADABLE,
      "网易云账号信息不完整，请重新登录网易云",
      401
    );
  }

  return { cookie, neteaseUserId };
}

/**
 * 当前用户自己的歌单分页。
 */
export async function listUserPlaylistsPage({
  db,
  principalKey,
  neteaseClient,
  limit,
  offset,
  env = process.env,
}) {
  const { cookie, neteaseUserId } = loadNeteaseCredential(db, principalKey, env);

  const { playlists, more } = await neteaseClient.listUserPlaylists({
    neteaseUserId,
    cookie,
    limit,
    offset,
  });

  return {
    playlists: playlists.map(normalizePlaylist).filter(Boolean),
    pagination: { limit, offset, more: more === true, total: null },
  };
}

export async function searchTracksPage({
  db,
  principalKey,
  neteaseClient,
  keywords,
  limit,
  offset,
  env = process.env,
}) {
  const { cookie } = loadNeteaseCredential(db, principalKey, env);
  const { songs, privileges, total } = await neteaseClient.searchTracks({
    keywords,
    cookie,
    limit,
    offset,
  });
  const privilegeMap = buildPrivilegeMap(privileges);
  const tracks = songs
    .map((song) =>
      normalizeTrack(
        song,
        privilegeMap.get(toIdString(song?.id)) || song?.privilege
      )
    )
    .filter(Boolean);
  return {
    tracks,
    pagination: {
      limit,
      offset,
      more: typeof total === "number" ? offset + tracks.length < total : tracks.length === limit,
      total,
    },
  };
}

export async function getVerifiedSearchTrack({
  db,
  principalKey,
  neteaseClient,
  songId,
  env = process.env,
}) {
  const { cookie } = loadNeteaseCredential(db, principalKey, env);
  const { song, privileges } = await neteaseClient.getSongDetail({ songId, cookie });
  const privilegeMap = buildPrivilegeMap(privileges);
  const track = song
    ? normalizeTrack(song, privilegeMap.get(toIdString(song.id)) || song.privilege)
    : null;
  if (!track || track.id !== songId) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.TRACK_NOT_FOUND,
      "未找到该歌曲，请重新搜索",
      404
    );
  }
  return { track };
}

/**
 * 有界分页扫描当前账号可见歌单（自建 + 收藏），
 * 确认 playlistId 属于当前账号；不属于时返回 null。
 */
async function findOwnedPlaylist({
  neteaseClient,
  neteaseUserId,
  cookie,
  playlistId,
}) {
  for (let page = 0; page < OWNERSHIP_SCAN_MAX_PAGES; page += 1) {
    const { playlists, more } = await neteaseClient.listUserPlaylists({
      neteaseUserId,
      cookie,
      limit: OWNERSHIP_SCAN_PAGE_SIZE,
      offset: page * OWNERSHIP_SCAN_PAGE_SIZE,
    });

    for (const raw of playlists) {
      const normalized = normalizePlaylist(raw);
      if (normalized && normalized.id === playlistId) {
        return normalized;
      }
    }

    if (!more || playlists.length === 0) break;
  }
  return null;
}

/**
 * 歌单歌曲分页。先做归属验证，再取歌曲，逐条标准化。
 */
export async function listPlaylistTracksPage({
  db,
  principalKey,
  neteaseClient,
  playlistId,
  limit,
  offset,
  env = process.env,
}) {
  const { cookie, neteaseUserId } = loadNeteaseCredential(db, principalKey, env);

  const ownedPlaylist = await findOwnedPlaylist({
    neteaseClient,
    neteaseUserId,
    cookie,
    playlistId,
  });
  if (!ownedPlaylist) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.PLAYLIST_NOT_FOUND,
      "未找到该歌单",
      404
    );
  }

  const { songs, privileges } = await neteaseClient.listPlaylistTracks({
    playlistId,
    cookie,
    limit,
    offset,
  });

  const privilegeById = new Map();
  for (const privilege of privileges) {
    const id = toIdString(privilege?.id);
    if (id) privilegeById.set(id, privilege);
  }

  const tracks = songs
    .map((song) => normalizeTrack(song, privilegeById.get(toIdString(song?.id))))
    .filter(Boolean);

  const total = ownedPlaylist.trackCount ?? null;
  const more =
    typeof total === "number"
      ? offset + tracks.length < total
      : tracks.length === limit;

  return {
    playlist: {
      id: ownedPlaylist.id,
      name: ownedPlaylist.name,
      coverImgUrl: ownedPlaylist.coverImgUrl,
      trackCount: ownedPlaylist.trackCount,
    },
    tracks,
    pagination: { limit, offset, more, total },
  };
}

function buildPrivilegeMap(privileges) {
  const map = new Map();
  for (const privilege of privileges) {
    const id = toIdString(privilege?.id);
    if (id) map.set(id, privilege);
  }
  return map;
}

/**
 * 点歌验证：归属验证后按 trackIndex 精确取该位置歌曲，
 * 服务端标准化并核对 songId 完全一致——前端提交的展示元数据一律不可信。
 */
export async function getVerifiedPlaylistTrack({
  db,
  principalKey,
  neteaseClient,
  playlistId,
  songId,
  trackIndex,
  env = process.env,
}) {
  const { cookie, neteaseUserId } = loadNeteaseCredential(db, principalKey, env);

  const ownedPlaylist = await findOwnedPlaylist({
    neteaseClient,
    neteaseUserId,
    cookie,
    playlistId,
  });
  if (!ownedPlaylist) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.PLAYLIST_NOT_FOUND,
      "未找到该歌单",
      404
    );
  }

  const { songs, privileges } = await neteaseClient.listPlaylistTracks({
    playlistId,
    cookie,
    limit: 1,
    offset: trackIndex,
  });

  const privilegeMap = buildPrivilegeMap(privileges);
  const track = songs.length
    ? normalizeTrack(songs[0], privilegeMap.get(toIdString(songs[0]?.id)))
    : null;

  if (!track || track.id !== songId) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.TRACK_NOT_FOUND,
      "歌曲与歌单位置不匹配，请刷新歌单后重试",
      404
    );
  }

  return { track, playlist: ownedPlaylist };
}

// 整歌单添加时最多扫描的歌曲数量
const PLAYLIST_ENQUEUE_MAX_SCAN = 1000;
const PLAYLIST_SCAN_PAGE_SIZE = 100;

/**
 * 收集歌单中可播放的歌曲（用于整歌单添加）：
 * 归属验证 → 分页扫描（上限 PLAYLIST_ENQUEUE_MAX_SCAN）→
 * 只收集 playable 歌曲直到 maxTracks，其余不可用歌曲计数跳过。
 * 不请求播放 URL。
 */
export async function getPlayableTracksForPlaylist({
  db,
  principalKey,
  neteaseClient,
  playlistId,
  maxTracks,
  env = process.env,
}) {
  const { cookie, neteaseUserId } = loadNeteaseCredential(db, principalKey, env);

  const ownedPlaylist = await findOwnedPlaylist({
    neteaseClient,
    neteaseUserId,
    cookie,
    playlistId,
  });
  if (!ownedPlaylist) {
    throw new MusicLibraryError(
      MUSIC_LIBRARY_ERROR.PLAYLIST_NOT_FOUND,
      "未找到该歌单",
      404
    );
  }

  const trackCount = ownedPlaylist.trackCount ?? PLAYLIST_ENQUEUE_MAX_SCAN;
  const scanLimit = Math.min(PLAYLIST_ENQUEUE_MAX_SCAN, trackCount);

  const collected = [];
  let skippedUnavailableCount = 0;
  let truncated = trackCount > PLAYLIST_ENQUEUE_MAX_SCAN;

  outer: for (let offset = 0; offset < scanLimit; offset += PLAYLIST_SCAN_PAGE_SIZE) {
    const limit = Math.min(PLAYLIST_SCAN_PAGE_SIZE, scanLimit - offset);
    const { songs, privileges } = await neteaseClient.listPlaylistTracks({
      playlistId,
      cookie,
      limit,
      offset,
    });
    if (songs.length === 0) break;

    const privilegeMap = buildPrivilegeMap(privileges);
    for (let index = 0; index < songs.length; index += 1) {
      const track = normalizeTrack(
        songs[index],
        privilegeMap.get(toIdString(songs[index]?.id))
      );
      if (!track) continue;
      if (!track.playable) {
        skippedUnavailableCount += 1;
        continue;
      }
      if (collected.length >= maxTracks) {
        truncated = true;
        break outer;
      }
      collected.push({ ...track, trackIndex: offset + index });
    }

    if (songs.length < limit) break;
  }

  return {
    playlist: ownedPlaylist,
    tracks: collected,
    skippedUnavailableCount,
    truncated,
  };
}
