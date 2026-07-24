import {
  useEffect,
  useRef,
  useState,
} from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE || "";

export default function LoginScreen({ onLogin }) {
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] =
    useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [registerUsername, setRegisterUsername] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState("");
  const [showGuestLogin, setShowGuestLogin] =
    useState(false);
  const [guestNickname, setGuestNickname] =
    useState("");

  const guestNicknameInputRef = useRef(null);

  useEffect(() => {
    if (showGuestLogin) {
      window.setTimeout(() => {
        guestNicknameInputRef.current?.focus();
      }, 0);
    }
  }, [showGuestLogin]);

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

  async function handleGuestLogin(event) {
    event.preventDefault();

    const cleanNickname =
      typeof guestNickname === "string"
        ? guestNickname.normalize("NFKC").trim()
        : "";

    if (!cleanNickname) {
      setError("请输入访客昵称");
      return;
    }

    try {
      setGuestLoading(true);
      setError("");

      const response = await fetch(
        `${API_BASE}/api/auth/guest-login`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            nickname: cleanNickname,
          }),
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await response.text();

        console.error(
          "访客登录接口没有返回 JSON：",
          text
        );

        throw new Error(
          "服务器访客登录接口返回异常"
        );
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "访客登录失败"
        );
      }

      if (!data.user) {
        throw new Error(
          "服务器没有返回访客信息"
        );
      }

      onLogin(data.user);
    } catch (loginError) {
      console.error(
        "NovaSpeak 访客登录失败：",
        loginError
      );

      setError(
        loginError.message ||
          "访客登录失败，请稍后重试"
      );
    } finally {
      setGuestLoading(false);
    }
  }

  async function handleRegistration(event) {
    event.preventDefault();
    const username = registerUsername.normalize("NFKC").trim();
    if (registerPassword !== registerConfirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    try {
      setLoading(true);
      setError("");
      setSuccess("");
      const response = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          username,
          password: registerPassword,
        }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("服务器注册接口返回异常");
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "注册失败");
      setNickname(username);
      setPassword("");
      setRegisterPassword("");
      setRegisterConfirmPassword("");
      setRegisterMode(false);
      setSuccess("注册成功，请使用新账号登录");
    } catch (registrationError) {
      console.error("NovaSpeak 注册失败：", registrationError);
      setError(registrationError.message || "注册失败，请稍后重试");
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
          onSubmit={
            registerMode
              ? handleRegistration
              : showGuestLogin
              ? handleGuestLogin
              : handleMemberLogin
          }
        >
          <div className="nova-team-name">
            NOVA GAMING
          </div>

          <h2>{registerMode ? "注册普通用户" : "账号登录"}</h2>

          <p className="login-description">
            {registerMode
              ? "创建普通语音用户账号，注册后返回登录"
              : "使用用户名和密码进入语音系统"}
          </p>

          <label className="login-field">
            <span>用户名</span>

            <input
              type="text"
              value={registerMode ? registerUsername : nickname}
              onChange={(event) =>
                registerMode
                  ? setRegisterUsername(event.target.value)
                  : setNickname(event.target.value)
              }
              placeholder="例如：CHILLILY"
              autoComplete="username"
              minLength={registerMode ? 2 : undefined}
              maxLength={registerMode ? 24 : 30}
              disabled={loading}
            />
          </label>

          <label className="login-field">
            <span>密码</span>

            <input
              type="password"
              value={registerMode ? registerPassword : password}
              onChange={(event) =>
                registerMode
                  ? setRegisterPassword(event.target.value)
                  : setPassword(event.target.value)
              }
              placeholder={registerMode ? "设置 8—128 位密码" : "请输入登录密码"}
              autoComplete={registerMode ? "new-password" : "current-password"}
              minLength={registerMode ? 8 : undefined}
              maxLength={128}
              disabled={loading}
            />
          </label>

          {registerMode && (
            <label className="login-field">
              <span>确认密码</span>
              <input
                type="password"
                value={registerConfirmPassword}
                onChange={(event) => setRegisterConfirmPassword(event.target.value)}
                placeholder="再次输入密码"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                disabled={loading}
              />
            </label>
          )}

          {error && (
            <div
              className="login-error"
              role="alert"
            >
              {error}
            </div>
          )}
          {success && (
            <div className="login-success" role="status">{success}</div>
          )}

          <button
            type="submit"
            className="member-login-button"
            disabled={loading}
          >
            {loading
              ? (registerMode ? "正在注册..." : "正在登录...")
              : (registerMode ? "创建普通用户账号" : "登录 NovaSpeak")}
          </button>

          {!registerMode && <div className="login-divider">
            <span />
            <p>或者</p>
            <span />
          </div>}

          {!registerMode && <button
            type="button"
            className="guest-login-button"
            onClick={() => {
              setError("");
              setShowGuestLogin(true);
            }}
            disabled={loading || guestLoading}
          >
            访客进入
          </button>}

          <button
            type="button"
            className="registration-toggle-button"
            onClick={() => {
              setRegisterMode((current) => !current);
              setShowGuestLogin(false);
              setError("");
              setSuccess("");
            }}
            disabled={loading || guestLoading}
          >
            {registerMode ? "返回账号登录" : "注册普通用户"}
          </button>

          {!registerMode && showGuestLogin && (
            <div
              className="guest-login-panel"
              role="dialog"
              aria-label="访客临时登录"
            >
              <label className="login-field">
                <span>临时昵称</span>

                <input
                  ref={guestNicknameInputRef}
                  type="text"
                  value={guestNickname}
                  onChange={(event) =>
                    setGuestNickname(event.target.value)
                  }
                  placeholder="例如：临时访客01"
                  autoComplete="off"
                  maxLength={24}
                  disabled={guestLoading}
                />
              </label>

              <div className="guest-notice">
                访客可查看频道、加入语音和使用基础聊天；频道和战队管理仅限正式成员。
              </div>

              <div className="guest-login-actions">
                <button
                  type="button"
                  className="guest-cancel-button"
                  onClick={() => {
                    setShowGuestLogin(false);
                    setGuestNickname("");
                    setError("");
                  }}
                  disabled={guestLoading}
                >
                  取消
                </button>

                <button
                  type="submit"
                  className="guest-enter-button"
                  disabled={guestLoading}
                >
                  {guestLoading
                    ? "正在进入..."
                    : "进入 NovaSpeak"}
                </button>
              </div>

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
