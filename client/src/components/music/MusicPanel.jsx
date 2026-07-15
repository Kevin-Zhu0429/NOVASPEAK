import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, Music, X } from "lucide-react";
import {
  bindNeteaseSession,
  getNeteaseAccount,
  unbindNeteaseSession,
} from "../../utils/music-api";
import PlaylistList from "./PlaylistList";
import PlaylistTracks from "./PlaylistTracks";

// 网易云音乐面板（第 4 阶段：账号绑定 + 歌单浏览）。
// Cookie 只在 loginNetease() 返回值 → bindNeteaseSession() 请求体之间
// 一次性传递：不进 state、不进 ref、不写 localStorage/sessionStorage。
export default function MusicPanel({ apiBase, onClose }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [account, setAccount] = useState(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [activePlaylist, setActivePlaylist] = useState(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const result = await getNeteaseAccount(apiBase);
        if (cancelled) return;
        setAccount(result.bound ? result.account || null : null);
        setAvatarFailed(false);
        setError("");
      } catch (queryError) {
        if (!cancelled) {
          setError(queryError.message || "查询网易云绑定状态失败");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [apiBase]);

  const handleSessionInvalid = useCallback(() => {
    setSessionExpired(true);
    setActivePlaylist(null);
  }, []);

  const handleLogin = async () => {
    if (busy) return;
    setError("");

    const bridge = typeof window !== "undefined" ? window.novaDesktop : null;
    if (!bridge?.isDesktop || typeof bridge.loginNetease !== "function") {
      setError("请使用 NovaSpeak 桌面版登录网易云音乐");
      return;
    }

    setBusy(true);
    try {
      const loginResult = await bridge.loginNetease();
      if (!loginResult?.ok) {
        // 用户主动关闭登录窗口不算错误
        if (loginResult?.cancelled) return;
        setError(
          loginResult?.timedOut
            ? "网易云登录超时，请重试"
            : "网易云登录失败，请重试"
        );
        return;
      }

      const bindResult = await bindNeteaseSession(apiBase, loginResult.cookies);
      if (!mountedRef.current) return;
      setAccount(bindResult.account || null);
      setAvatarFailed(false);
      // 重新登录成功：清空旧歌单和歌曲状态并重新加载
      setSessionExpired(false);
      setActivePlaylist(null);
      setLibraryRevision((revision) => revision + 1);
    } catch (bindError) {
      if (mountedRef.current) {
        setError(bindError.message || "绑定网易云账号失败");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await unbindNeteaseSession(apiBase);
      if (!mountedRef.current) return;
      // 退出后清空账号、歌单、当前歌单和歌曲状态
      setAccount(null);
      setActivePlaylist(null);
      setSessionExpired(false);
    } catch (unbindError) {
      if (mountedRef.current) {
        setError(unbindError.message || "退出网易云账号失败");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="music-panel" role="dialog" aria-label="网易云音乐">
      <div className="music-panel-header">
        <span className="music-panel-title">
          <Music />
          网易云音乐
        </span>
        <button
          type="button"
          className="music-panel-close"
          onClick={onClose}
          aria-label="关闭音乐面板"
        >
          <X />
        </button>
      </div>

      {loading ? (
        <div className="music-panel-loading">正在加载绑定状态……</div>
      ) : account ? (
        <>
          <div className="music-account">
            {account.avatarUrl && !avatarFailed ? (
              <img
                className="music-account-avatar"
                src={account.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <div
                className="music-account-avatar music-account-avatar-fallback"
                aria-hidden="true"
              >
                <Music />
              </div>
            )}
            <div className="music-account-info">
              <strong>{account.nickname || "网易云用户"}</strong>
              <span>已绑定网易云音乐</span>
            </div>
            <button
              type="button"
              className="music-logout-button"
              onClick={handleLogout}
              disabled={busy}
              aria-label="退出网易云账号"
            >
              {busy ? "处理中……" : "退出账号"}
            </button>
          </div>

          <div className="music-panel-body">
            {sessionExpired ? (
              <div className="music-session-expired">
                <p>网易云登录已失效，请重新登录</p>
                <button
                  type="button"
                  className="music-login-button"
                  onClick={handleLogin}
                  disabled={busy}
                >
                  <LogIn />
                  {busy ? "等待登录……" : "重新登录网易云"}
                </button>
              </div>
            ) : activePlaylist ? (
              <PlaylistTracks
                key={`${libraryRevision}-${activePlaylist.id}`}
                apiBase={apiBase}
                playlist={activePlaylist}
                onBack={() => setActivePlaylist(null)}
                onSessionInvalid={handleSessionInvalid}
              />
            ) : (
              <PlaylistList
                key={libraryRevision}
                apiBase={apiBase}
                onSelectPlaylist={setActivePlaylist}
                onSessionInvalid={handleSessionInvalid}
              />
            )}
          </div>
        </>
      ) : (
        <div className="music-login">
          <p>绑定网易云账号后，就可以在频道里使用音乐机器人播放自己的歌单。</p>
          <button
            type="button"
            className="music-login-button"
            onClick={handleLogin}
            disabled={busy}
          >
            <LogIn />
            {busy ? "等待登录……" : "登录网易云音乐"}
          </button>
        </div>
      )}

      {error && <div className="music-panel-error">{error}</div>}
    </div>
  );
}
