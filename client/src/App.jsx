import { useCallback, useEffect, useRef, useState } from "react";
import ChannelList from "./components/ChannelList";
import LoginScreen from "./components/auth/LoginScreen";
import AccountSettings from "./components/account/AccountSettings";
import TeamManagement from "./components/team/TeamManagement";
import TeamMembers from "./components/team/TeamMembers";
import ChannelManagementPanel from "./components/channels/ChannelManagementPanel";
import WelcomeOverlay from "./components/auth/WelcomeOverlay";
import VoiceRoom from "./components/voice/VoiceRoom";
import OnlineMembersPanel from "./components/presence/OnlineMembersPanel";
import usePresence from "./hooks/usePresence";
import { getPositionText } from "./utils/user-display";
import { sortChannels } from "./utils/channel-settings";
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
  const [showChannelManagement, setShowChannelManagement] = useState(false);
  const [teamMembersRevision, setTeamMembersRevision] = useState(0);
  const [voiceNotice, setVoiceNotice] = useState("");
  const channelRequestIdRef = useRef(0);
  const lastChannelFetchErrorRef = useRef("");

  const [welcomeUser,setWelcomeUser,] = useState(null);
  const presence = usePresence(currentUser, API_BASE);

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

  const invalidateChannelRequests = useCallback(function invalidateChannelRequests() {
    channelRequestIdRef.current += 1;
  }, []);

  const fetchChannels = useCallback(async function fetchChannels() {
    const requestId = ++channelRequestIdRef.current;
    try {
      const response = await fetch(
        `${API_BASE}/api/channels`,
        {
          credentials: "include",
        }
      );
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("获取频道列表失败");
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "获取频道列表失败");
      }

      if (requestId !== channelRequestIdRef.current) return data;

      const sortedData = sortChannels(data);
      lastChannelFetchErrorRef.current = "";
      setChannels(sortedData);
      setCurrentChannel((current) => {
        if (!current) return current;
        return sortedData.find((channel) => channel.id === current.id) || current;
      });
      return sortedData;
    } catch (error) {
      if (requestId !== channelRequestIdRef.current) return null;
      const message = error?.message || "获取频道列表失败";
      if (lastChannelFetchErrorRef.current !== message) {
        console.error("获取频道列表失败：", error);
        lastChannelFetchErrorRef.current = message;
      }
      return null;
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

  async function leaveCurrentChannel(message) {
    presence.setLocation({ state: "lobby", channelId: null });
    setCurrentChannel(null);
    if (message) setVoiceNotice(message);
    await fetchChannels();
  }

  const handleMovedToChannel = useCallback((channelId, message) => {
    const nextChannel = channels.find((item) => item.id === channelId);
    if (nextChannel) {
      setCurrentChannel(nextChannel);
      presence.setLocation({ state: "in_channel", channelId });
      if (message) setVoiceNotice(message);
    }
  }, [channels, presence]);

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
      {voiceNotice && (
        <div className="nova-voice-notice">
          <span>{voiceNotice}</span>
          <button type="button" onClick={() => setVoiceNotice("")}>关闭</button>
        </div>
      )}
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
              onOpenChannelManagement={
                currentUser.role === "admin"
                  ? () => setShowChannelManagement(true)
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
            <div className="lobby-content"><div className="empty-state" /><OnlineMembersPanel members={presence.members} connectionStatus={presence.connectionStatus} /></div>
          ) : (
            <VoiceRoom
              channel={currentChannel}
              channels={channels}
              currentUser={currentUser}
              apiBase={API_BASE}
              onLeave={leaveCurrentChannel}
              onMovedToChannel={handleMovedToChannel}
              onChannelsChanged={fetchChannels}
              onPresenceLocationChange={presence.setLocation}
              onlineMembers={presence.members}
              presenceStatus={presence.connectionStatus}
            />
          )}
        </main>
      </div>

       {welcomeUser && (
        <WelcomeOverlay
          user={welcomeUser}
        />
      )}

      {showChannelManagement &&
        currentUser.role === "admin" && (
          <ChannelManagementPanel
            channels={channels}
            apiBase={API_BASE}
            onRefreshChannels={fetchChannels}
            onInvalidateChannels={invalidateChannelRequests}
            onClose={() => setShowChannelManagement(false)}
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
