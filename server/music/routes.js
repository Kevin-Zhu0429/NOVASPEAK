// 网易云账号绑定接口：/api/music/netease/*
// 复用现有 requireAuthenticated 认证，身份只取 req.authUser，
// 未配置 MUSIC_CREDENTIAL_KEY 时统一返回 503 MUSIC_NOT_CONFIGURED，
// 不影响 NOVASPEAK 其他功能。响应中绝不包含 Cookie、密文、IV 或 auth tag。

import express from "express";
import {
  encryptMusicCredential,
  isMusicCredentialConfigured,
  MUSIC_NOT_CONFIGURED,
} from "./credential-store.js";
import {
  deleteNeteaseBinding,
  getCredentialExpiry,
  getMusicPrincipal,
  getNeteaseAccountRow,
  saveNeteaseBinding,
  toPublicNeteaseAccount,
} from "./account-service.js";
import { normalizeNeteaseCookie } from "./netease-cookie.js";
import { NETEASE_ERROR, NeteaseError } from "./netease-client.js";
import {
  MusicLibraryError,
  getPlayableTracksForPlaylist,
  getVerifiedPlaylistTrack,
  listPlaylistTracksPage,
  listUserPlaylistsPage,
} from "./library-service.js";
import { isValidPlaylistId, parsePageParams } from "./netease-normalizers.js";
import {
  MUSIC_QUEUE_ERROR,
  MusicQueueError,
  cancelPendingItemsForPrincipal,
  cancelQueueItem,
  enqueueTracks,
  getQueueSnapshot,
  getRemainingQueueCapacity,
} from "./music-queue.js";

function sendNeteaseError(res, error) {
  if (error instanceof NeteaseError) {
    if (error.code === NETEASE_ERROR.SESSION_INVALID) {
      return res.status(401).json({ error: error.message, code: error.code });
    }
    if (error.code === NETEASE_ERROR.RATE_LIMITED) {
      return res.status(429).json({ error: error.message, code: error.code });
    }
    return res.status(502).json({ error: error.message, code: error.code });
  }
  if (error instanceof MusicLibraryError || error instanceof MusicQueueError) {
    return res
      .status(error.status || 500)
      .json({ error: error.message, code: error.code });
  }
  if (error?.code === MUSIC_NOT_CONFIGURED) {
    return res.status(503).json({
      error: "音乐功能尚未配置，请联系管理员",
      code: MUSIC_NOT_CONFIGURED,
    });
  }
  return null;
}

export function createNeteaseMusicRouter({
  db,
  neteaseClient,
  requireAuthenticated,
  presenceService = null,
  onQueueUpdated = null,
  playbackController = null,
  env = process.env,
}) {
  // 入队成功后通知音乐机器人管理器（绝不 await、绝不影响 HTTP 响应）
  function notifyQueueUpdated(channelId) {
    try {
      onQueueUpdated?.(channelId);
    } catch (error) {
      console.error("Music queue kick error:", error?.message);
    }
  }
  const router = express.Router();

  // 频道队列接口的成员校验：不能只相信前端传来的 channelId，
  // 必须通过 Presence 确认当前用户确实位于目标频道
  function requireInChannel(req, res, next) {
    const channelId = req.params.channelId;
    if (typeof channelId !== "string" || !channelId || channelId.length > 128) {
      return res.status(400).json({ error: "频道 ID 无效" });
    }
    if (!presenceService?.isUserInChannel?.(req.authUser.id, channelId)) {
      return res.status(403).json({
        error: "请先进入该语音频道",
        code: MUSIC_QUEUE_ERROR.NOT_IN_CHANNEL,
      });
    }
    next();
  }

  router.use(requireAuthenticated);

  // 未配置加密密钥时音乐功能整体不可用
  router.use((req, res, next) => {
    if (!isMusicCredentialConfigured(env)) {
      return res.status(503).json({
        error: "音乐功能尚未配置，请联系管理员",
        code: MUSIC_NOT_CONFIGURED,
      });
    }
    next();
  });

  router.use((req, res, next) => {
    const principal = getMusicPrincipal(req.authUser);
    if (!principal) {
      return res.status(401).json({ error: "请先登录" });
    }
    req.musicPrincipal = principal;
    next();
  });

  router.get("/account", (req, res) => {
    try {
      const row = getNeteaseAccountRow(db, req.musicPrincipal.key);
      if (!row) {
        return res.json({ bound: false });
      }
      return res.json({
        bound: true,
        account: toPublicNeteaseAccount(row),
      });
    } catch (error) {
      console.error("Netease account query error:", error?.message);
      return res.status(500).json({ error: "查询网易云绑定状态失败" });
    }
  });

  router.post("/session", async (req, res) => {
    try {
      const normalized = normalizeNeteaseCookie(req.body?.cookies);
      if (!normalized.ok) {
        return res.status(400).json({
          error: normalized.error,
          code: normalized.code,
        });
      }

      const profile = await neteaseClient.verifySession(
        normalized.cookieHeader
      );

      const encrypted = encryptMusicCredential(normalized.cookieHeader, env);

      saveNeteaseBinding(db, {
        principalKey: req.musicPrincipal.key,
        encrypted,
        profile,
        credentialExpiresAt: getCredentialExpiry(req.musicPrincipal),
      });

      return res.json({
        success: true,
        bound: true,
        account: {
          neteaseUserId: profile.neteaseUserId,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
        },
      });
    } catch (error) {
      const handled = sendNeteaseError(res, error);
      if (handled) return handled;
      if (error?.code === MUSIC_NOT_CONFIGURED) {
        return res.status(503).json({
          error: "音乐功能尚未配置，请联系管理员",
          code: MUSIC_NOT_CONFIGURED,
        });
      }
      console.error("Netease bind error:", error?.message);
      return res.status(500).json({ error: "绑定网易云账号失败" });
    }
  });

  router.delete("/session", (req, res) => {
    try {
      // 解绑后下一阶段无法再用该账号取播放 URL：
      // 同一事务中取消该 principal 的所有待播放队列项
      const result = db.transaction(() => {
        const removed = deleteNeteaseBinding(db, req.musicPrincipal.key);
        const cancelledPending = cancelPendingItemsForPrincipal(
          db,
          req.musicPrincipal.key
        );
        return { removed, cancelledPending };
      })();
      return res.json({
        success: true,
        bound: false,
        removed: result.removed,
        cancelledPending: result.cancelledPending,
      });
    } catch (error) {
      console.error("Netease unbind error:", error?.message);
      return res.status(500).json({ error: "解绑网易云账号失败" });
    }
  });

  router.get("/playlists", async (req, res) => {
    const page = parsePageParams(req.query, { defaultLimit: 30, maxLimit: 50 });
    if (!page.ok) {
      return res
        .status(400)
        .json({ error: page.error, code: "INVALID_PAGINATION" });
    }
    try {
      const result = await listUserPlaylistsPage({
        db,
        principalKey: req.musicPrincipal.key,
        neteaseClient,
        limit: page.limit,
        offset: page.offset,
        env,
      });
      return res.json(result);
    } catch (error) {
      const handled = sendNeteaseError(res, error);
      if (handled) return handled;
      console.error("Netease playlists error:", error?.message);
      return res.status(500).json({ error: "获取网易云歌单失败" });
    }
  });

  router.get("/playlists/:playlistId/tracks", async (req, res) => {
    const playlistId = req.params.playlistId;
    if (!isValidPlaylistId(playlistId)) {
      return res
        .status(400)
        .json({ error: "歌单编号无效", code: "INVALID_PLAYLIST_ID" });
    }
    const page = parsePageParams(req.query, { defaultLimit: 50, maxLimit: 100 });
    if (!page.ok) {
      return res
        .status(400)
        .json({ error: page.error, code: "INVALID_PAGINATION" });
    }
    try {
      const result = await listPlaylistTracksPage({
        db,
        principalKey: req.musicPrincipal.key,
        neteaseClient,
        playlistId,
        limit: page.limit,
        offset: page.offset,
        env,
      });
      return res.json(result);
    } catch (error) {
      const handled = sendNeteaseError(res, error);
      if (handled) return handled;
      console.error("Netease playlist tracks error:", error?.message);
      return res.status(500).json({ error: "获取歌单歌曲失败" });
    }
  });

  // ---------- 频道音乐队列 ----------

  const SONG_ID_PATTERN = /^\d{1,20}$/;
  const QUEUE_ITEM_ID_PATTERN = /^\d{1,18}$/;
  const MAX_TRACK_INDEX = 9999;

  function currentViewer(req) {
    return {
      principalKey: req.musicPrincipal.key,
      isAdmin: req.authUser.role === "admin",
    };
  }

  function getPublicQueueSnapshot(req) {
    const snapshot = getQueueSnapshot(db, {
      channelId: req.params.channelId,
      viewer: currentViewer(req),
    });
    const state = playbackController?.getPlaybackState?.(
      req.params.channelId
    );
    if (
      snapshot.nowPlaying &&
      state?.active === true &&
      String(state.queueItemId) === snapshot.nowPlaying.id
    ) {
      snapshot.nowPlaying.playback.paused = state.paused === true;
      snapshot.nowPlaying.playback.elapsedMs = Math.min(
        snapshot.nowPlaying.playback.durationMs,
        Math.max(0, Number(state.elapsedMs) || 0)
      );
    }
    snapshot.controls = {
      canControlPlayback:
        req.authUser.role === "admin" || req.authUser.role === "member",
    };
    return snapshot;
  }

  function requirePlaybackMember(req, res, next) {
    if (req.authUser.role !== "admin" && req.authUser.role !== "member") {
      return res.status(403).json({
        error: "只有正式战队成员可以控制频道音乐播放",
        code: "MUSIC_PLAYBACK_FORBIDDEN",
      });
    }
    next();
  }

  // 单曲点歌：前端只提交 playlistId/songId/trackIndex，
  // 歌曲元数据一律由服务端从网易云取回并标准化后入队
  router.post(
    "/channels/:channelId/queue/tracks",
    requireInChannel,
    async (req, res) => {
      try {
        const { playlistId, songId } = req.body || {};
        const trackIndex = req.body?.trackIndex;
        if (!isValidPlaylistId(playlistId)) {
          return res
            .status(400)
            .json({ error: "歌单编号无效", code: "INVALID_PLAYLIST_ID" });
        }
        if (typeof songId !== "string" || !SONG_ID_PATTERN.test(songId)) {
          return res.status(400).json({ error: "歌曲编号无效" });
        }
        if (
          !Number.isInteger(trackIndex) ||
          trackIndex < 0 ||
          trackIndex > MAX_TRACK_INDEX
        ) {
          return res.status(400).json({ error: "歌曲位置无效" });
        }

        const { track } = await getVerifiedPlaylistTrack({
          db,
          principalKey: req.musicPrincipal.key,
          neteaseClient,
          playlistId,
          songId,
          trackIndex,
          env,
        });

        if (!track.playable) {
          return res.status(409).json({
            error: track.unavailableReason || "该歌曲当前不可播放",
            code: MUSIC_QUEUE_ERROR.TRACK_UNAVAILABLE,
          });
        }

        const result = enqueueTracks(db, {
          channelId: req.params.channelId,
          principalKey: req.musicPrincipal.key,
          requesterDisplayName: req.authUser.displayName,
          tracks: [{ ...track, trackIndex }],
          playlistId,
        });

        const snapshot = getPublicQueueSnapshot(req);
        const queueItemId = result.queueItemIds[0];
        const projected = snapshot.items.find((item) => item.id === queueItemId);

        notifyQueueUpdated(req.params.channelId);
        return res.json({
          success: true,
          addedCount: result.addedCount,
          queueItemId,
          projectedPosition: projected?.projectedPosition ?? null,
          revision: result.revision,
        });
      } catch (error) {
        const handled = sendNeteaseError(res, error);
        if (handled) return handled;
        console.error("Music enqueue track error:", error?.message);
        return res.status(500).json({ error: "点歌失败" });
      }
    }
  );

  // 整个歌单添加：只加入可播放歌曲，受用户/频道容量限制，
  // 全部读取标准化后在单个数据库事务中写入
  router.post(
    "/channels/:channelId/queue/playlists",
    requireInChannel,
    async (req, res) => {
      try {
        const { playlistId } = req.body || {};
        if (!isValidPlaylistId(playlistId)) {
          return res
            .status(400)
            .json({ error: "歌单编号无效", code: "INVALID_PLAYLIST_ID" });
        }

        const capacity = getRemainingQueueCapacity(
          db,
          req.params.channelId,
          req.musicPrincipal.key
        );
        if (capacity.userRemaining <= 0) {
          return res.status(409).json({
            error: "你的排队歌曲已达上限，请先等待播放或取消部分歌曲",
            code: MUSIC_QUEUE_ERROR.USER_LIMIT,
          });
        }
        if (capacity.channelRemaining <= 0) {
          return res.status(409).json({
            error: "频道队列已满，请稍后再试",
            code: MUSIC_QUEUE_ERROR.CHANNEL_LIMIT,
          });
        }

        const scan = await getPlayableTracksForPlaylist({
          db,
          principalKey: req.musicPrincipal.key,
          neteaseClient,
          playlistId,
          maxTracks: capacity.remaining,
          env,
        });

        if (scan.tracks.length === 0) {
          return res.status(409).json({
            error: "歌单中没有可添加的歌曲",
            code: MUSIC_QUEUE_ERROR.TRACK_UNAVAILABLE,
          });
        }

        const result = enqueueTracks(db, {
          channelId: req.params.channelId,
          principalKey: req.musicPrincipal.key,
          requesterDisplayName: req.authUser.displayName,
          tracks: scan.tracks,
          playlistId,
        });

        notifyQueueUpdated(req.params.channelId);
        return res.json({
          success: true,
          addedCount: result.addedCount,
          skippedUnavailableCount: scan.skippedUnavailableCount,
          truncated: scan.truncated || result.truncated,
          revision: result.revision,
        });
      } catch (error) {
        const handled = sendNeteaseError(res, error);
        if (handled) return handled;
        console.error("Music enqueue playlist error:", error?.message);
        return res.status(500).json({ error: "添加歌单失败" });
      }
    }
  );

  // 共享队列快照：当前频道用户可见，按预计公平播放顺序返回
  router.get("/channels/:channelId/queue", requireInChannel, (req, res) => {
    try {
      const snapshot = getPublicQueueSnapshot(req);
      return res.json(snapshot);
    } catch (error) {
      const handled = sendNeteaseError(res, error);
      if (handled) return handled;
      console.error("Music queue snapshot error:", error?.message);
      return res.status(500).json({ error: "获取频道队列失败" });
    }
  });

  router.post(
    "/channels/:channelId/playback/pause",
    requireInChannel,
    requirePlaybackMember,
    (req, res) => {
      if (typeof req.body?.paused !== "boolean") {
        return res.status(400).json({
          error: "暂停状态无效",
          code: "MUSIC_PLAYBACK_INVALID_STATE",
        });
      }
      const result = playbackController?.setPaused?.(
        req.params.channelId,
        req.body.paused
      );
      if (!result?.active) {
        return res.status(409).json({
          error: "当前没有正在播放的歌曲",
          code: "MUSIC_NOT_PLAYING",
        });
      }
      return res.json({
        success: true,
        playback: {
          paused: result.paused === true,
          elapsedMs: Math.max(0, Number(result.elapsedMs) || 0),
        },
      });
    }
  );

  router.post(
    "/channels/:channelId/playback/skip",
    requireInChannel,
    requirePlaybackMember,
    async (req, res) => {
      const result = await playbackController?.skip?.(req.params.channelId);
      if (!result?.changed) {
        return res.status(409).json({
          error: "当前没有可以切换的歌曲",
          code: "MUSIC_NOT_PLAYING",
        });
      }
      return res.json({ success: true });
    }
  );

  // 取消待播放歌曲：本人或 admin
  router.delete(
    "/channels/:channelId/queue/:queueItemId",
    requireInChannel,
    (req, res) => {
      try {
        const queueItemId = req.params.queueItemId;
        if (!QUEUE_ITEM_ID_PATTERN.test(queueItemId)) {
          return res.status(400).json({ error: "队列项编号无效" });
        }
        const viewer = currentViewer(req);
        const result = cancelQueueItem(db, {
          channelId: req.params.channelId,
          queueItemId: Number(queueItemId),
          principalKey: viewer.principalKey,
          isAdmin: viewer.isAdmin,
        });
        return res.json({ success: true, revision: result.revision });
      } catch (error) {
        const handled = sendNeteaseError(res, error);
        if (handled) return handled;
        console.error("Music queue cancel error:", error?.message);
        return res.status(500).json({ error: "取消歌曲失败" });
      }
    }
  );

  return router;
}
