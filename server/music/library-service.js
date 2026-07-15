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
