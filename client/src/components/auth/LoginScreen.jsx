import { useState } from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE || "";

export default function LoginScreen({ onLogin }) {
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showGuestNotice, setShowGuestNotice] =
    useState(false);

  async function handleMemberLogin(event) {
    event.preventDefault();

    const cleanNickname = nickname
      .normalize("NFKC")
      .trim();

    if (!cleanNickname || !password) {
      setError("请输入游戏昵称和密码");
      return;
    }

    try {
      setLoading(true);
      setError("");

      console.log("正在提交登录请求：", cleanNickname);

      const response = await fetch(
        `${API_BASE}/api/auth/member-login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            nickname: cleanNickname,
            password,
          }),
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await response.text();

        console.error(
          "登录接口没有返回 JSON：",
          text
        );

        throw new Error(
          "服务器登录接口返回异常"
        );
      }

      const data = await response.json();

      console.log("登录接口返回：", data);

      if (!response.ok) {
        throw new Error(
          data.error || "登录失败"
        );
      }

      if (!data.user) {
        throw new Error(
          "服务器没有返回用户信息"
        );
      }

      if (typeof onLogin !== "function") {
        throw new Error(
          "前端登录回调没有正确配置"
        );
      }

      onLogin(data.user);
    } catch (loginError) {
      console.error(
        "NovaSpeak 登录失败：",
        loginError
      );

      setError(
        loginError.message ||
          "登录失败，请稍后重试"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="nova-login-page">
      <div className="nova-login-container">
        <header className="nova-login-header">
          <div className="nova-logo-mark">
            N
          </div>

          <h1>NOVA SPEAK</h1>

          <p>
            Private voice communication
          </p>
        </header>

        <form
          className="nova-member-login-card"
          onSubmit={handleMemberLogin}
        >
          <div className="nova-team-name">
            NOVA GAMING
          </div>

          <h2>战队成员登录</h2>

          <p className="login-description">
            使用游戏昵称和密码进入语音系统
          </p>

          <label className="login-field">
            <span>游戏昵称</span>

            <input
              type="text"
              value={nickname}
              onChange={(event) =>
                setNickname(event.target.value)
              }
              placeholder="例如：CHILLILY"
              autoComplete="username"
              maxLength={30}
              disabled={loading}
            />
          </label>

          <label className="login-field">
            <span>密码</span>

            <input
              type="password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              placeholder="请输入登录密码"
              autoComplete="current-password"
              maxLength={128}
              disabled={loading}
            />
          </label>

          {error && (
            <div
              className="login-error"
              role="alert"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            className="member-login-button"
            disabled={loading}
          >
            {loading
              ? "正在登录..."
              : "登录 NovaSpeak"}
          </button>

          <div className="login-divider">
            <span />
            <p>或者</p>
            <span />
          </div>

          <button
            type="button"
            className="guest-login-button"
            onClick={() =>
              setShowGuestNotice(
                (current) => !current
              )
            }
          >
            访客登录
          </button>

          {showGuestNotice && (
            <div className="guest-notice">
              访客登录功能暂未开放。
            </div>
          )}
        </form>

        <footer className="nova-login-footer">
          NOVA GAMING PRIVATE NETWORK
        </footer>
      </div>
    </div>
  );
}