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
  listPlaylistTracksPage,
  listUserPlaylistsPage,
} from "./library-service.js";
import { isValidPlaylistId, parsePageParams } from "./netease-normalizers.js";

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
  if (error instanceof MusicLibraryError) {
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
  env = process.env,
}) {
  const router = express.Router();

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
      const removed = deleteNeteaseBinding(db, req.musicPrincipal.key);
      return res.json({ success: true, bound: false, removed });
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

  return router;
}
