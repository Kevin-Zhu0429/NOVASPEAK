import { useCallback, useEffect, useState } from "react";
import ChannelList from "./components/ChannelList";
import LoginScreen from "./components/auth/LoginScreen";
import AccountSettings from "./components/account/AccountSettings";
import TeamManagement from "./components/team/TeamManagement";
import TeamMembers from "./components/team/TeamMembers";
import WelcomeOverlay from "./components/auth/WelcomeOverlay";
import VoiceRoom from "./components/voice/VoiceRoom";
import { getPositionText } from "./utils/user-display";
import "./App.css";


const API_BASE = import.meta.env.VITE_API_BASE || "";
export default function App() {
  const [authLoading, setAuthLoading] = useState(true);

  const [currentUser, setCurrentUser] = useState(null);

  const username = currentUser?.displayName || "";
  const canManageChannels =
    currentUser?.role === "admin" ||
    currentUser?.role === "member";

  const [channels, setChannels] = useState([]);
  const [currentChannel, setCurrentChannel] = useState(null);
  const [showTeamManagement,setShowTeamManagement,] = useState(false);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [showTeamMembers, setShowTeamMembers] = useState(false);
  const [teamMembersRevision, setTeamMembersRevision] = useState(0);

  const [welcomeUser,setWelcomeUser,] = useState(null);

  useEffect(() => {
  let cancelled = false;

  async function checkAuthentication() {
    try {
      const response = await fetch(
        `${API_BASE}/api/auth/me`,
        {
          credentials: "include",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "无法检查登录状态"
        );
      }

      if (!cancelled) {
        setCurrentUser(data.user || null);
      }
    } catch (error) {
      console.error(
        "Authentication check error:",
        error
      );

      if (!cancelled) {
        setCurrentUser(null);
      }
    } finally {
      if (!cancelled) {
        setAuthLoading(false);
      }
    }
  }

  checkAuthentication();

  return () => {
    cancelled = true;
  };
}, []);

  const fetchChannels = useCallback(async function fetchChannels() {
    try {
      const response = await fetch(
        `${API_BASE}/api/channels`,
        {
          credentials: "include",
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "获取频道列表失败");
      }

      setChannels(data);
    } catch (error) {
      console.error("获取频道列表失败：", error);
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return undefined;
    queueMicrotask(fetchChannels);
    const timer = setInterval(fetchChannels, 3000);
    return () => clearInterval(timer);
  }, [currentUser, fetchChannels]);

  async function createChannel(name) {
    try {
      const response = await fetch( `${API_BASE}/api/channels`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ name }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "创建频道失败");
      }

      await fetchChannels();
    } catch (error) {
      console.error("创建频道失败：", error);
      alert(`创建频道失败：${error.message}`);
    }
  }

  function handleLogin(user) {
    setCurrentUser(user);
    setWelcomeUser(user);

    window.setTimeout(() => {
      setWelcomeUser(null);
    }, 6000);
  }

  async function leaveCurrentChannel() {
    setCurrentChannel(null);
    await fetchChannels();
  }

  async function logout() {
  try {
    setCurrentChannel(null);

    const response = await fetch(
      `${API_BASE}/api/auth/logout`,
      {
        method: "POST",
        credentials: "include",
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error || "退出登录失败"
      );
    }

    setCurrentUser(null);
  } catch (error) {
    console.error(
      "Logout error:",
      error
    );

    alert(
      error.message || "退出登录失败"
    );
  }
}

  async function joinChannel(channel) {
    if (!username.trim()) {
      alert("请先输入昵称");
      return;
    }

    setCurrentChannel(channel);
  }

  if (authLoading) {
  return (
    <div className="nova-auth-loading">
      <div className="auth-loading-logo">
        N
      </div>

      <h1>NOVA SPEAK</h1>

      <p>正在验证登录状态...</p>
    </div>
  );
}

if (!currentUser) {
  return (
    <LoginScreen
      onLogin={handleLogin}
    />
  );
}

  return (
    <>
      <div className="main-layout">
        <aside className="sidebar">
          <div className="sidebar-main">
            <div className="brand">
              <h2>NovaSpeak</h2>

              <span>
                NOVA GAMING TEAMSPEAK
              </span>
            </div>

            <ChannelList
              channels={channels}
              currentChannel={currentChannel}
              onJoinChannel={joinChannel}
              onCreateChannel={
                canManageChannels
                  ? createChannel
                  : null
              }
            />
          </div>

          <div className="sidebar-footer">
            {!currentUser.isGuest && (
              <button
                type="button"
                className="sidebar-account-action"
                onClick={() => setShowAccountSettings(true)}
              >
                <span className="management-icon">◎</span>
                我的账号
              </button>
            )}

            <button
              type="button"
              className="sidebar-account-action"
              onClick={() => setShowTeamMembers(true)}
            >
              <span className="management-icon">◉</span>
              战队成员
            </button>

            {currentUser.role === "admin" && (
              <button
                type="button"
                className="team-management-button"
                onClick={() =>
                  setShowTeamManagement(true)
                }
              >
                <span className="management-icon">
                  ⚙
                </span>

                战队管理
              </button>
            )}

            <div className="account-panel">
              <div className="account-avatar">
                {currentUser.displayName
                  .slice(0, 1)
                  .toUpperCase()}
              </div>

              <div className="account-details">
                <strong>
                  {currentUser.displayName}
                </strong>

                <span>
                  {getPositionText(currentUser)}
                </span>
              </div>

              <button
                type="button"
                className="logout-button"
                onClick={logout}
                title={currentUser.isGuest ? "退出访客模式" : "退出登录"}
              >
                {currentUser.isGuest ? "退出访客模式" : "退出"}
              </button>
            </div>
          </div>
        </aside>

        <main className="chat-panel">
          {!currentChannel ? (
            <div className="empty-state" />
          ) : (
            <VoiceRoom
              channel={currentChannel}
              currentUser={currentUser}
              apiBase={API_BASE}
              onLeave={leaveCurrentChannel}
              onChannelsChanged={fetchChannels}
            />
          )}
        </main>
      </div>

       {welcomeUser && (
        <WelcomeOverlay
          user={welcomeUser}
        />
      )}

      {showTeamManagement &&
        currentUser.role === "admin" && (
          <TeamManagement
            currentUser={currentUser}
            onUserUpdated={setCurrentUser}
            onMembersChanged={() =>
              setTeamMembersRevision((revision) => revision + 1)
            }
            onClose={() =>
              setShowTeamManagement(false)
          }
        />
      )}

      {showAccountSettings &&
        !currentUser.isGuest && (
          <AccountSettings
            currentUser={currentUser}
            onUserUpdated={setCurrentUser}
            onClose={() => setShowAccountSettings(false)}
          />
        )}

      {showTeamMembers && (
        <TeamMembers
          key={teamMembersRevision}
          onClose={() => setShowTeamMembers(false)}
        />
      )}
    </>
  );
}
