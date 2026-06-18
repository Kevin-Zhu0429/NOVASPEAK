import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import ChannelList from "./components/ChannelList";
import LoginScreen from "./components/auth/LoginScreen";
import TeamManagement from "./components/team/TeamManagement";
import WelcomeOverlay from "./components/auth/WelcomeOverlay";
import "./App.css";


const API_BASE = import.meta.env.VITE_API_BASE || "";
const CHAT_TOPIC = "nova-chat";

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);

  const [currentUser, setCurrentUser] = useState(null);

  const username = currentUser?.displayName || "";
  const canManageChannels =
    currentUser?.role === "admin" ||
    currentUser?.role === "member";

  const [channels, setChannels] = useState([]);
  const [currentChannel, setCurrentChannel] = useState(null);
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);

  const [participants, setParticipants] = useState([]);
  const [activeSpeakers, setActiveSpeakers] = useState([]);

  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");

  const roomRef = useRef(null);
  const audioElementsRef = useRef([]);

  const [showTeamManagement,setShowTeamManagement,] = useState(false);

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

  useEffect(() => {
  if (!currentUser) return undefined;

  fetchChannels();

  const timer = setInterval(() => {
    fetchChannels();
  }, 3000);

  return () => clearInterval(timer);
}, [currentUser]);

  async function fetchChannels() {
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
  }

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

  function refreshParticipants(room) {
    if (!room) return;

    const localName = room.localParticipant.identity;

    const remoteNames = Array.from(room.remoteParticipants.values()).map(
      (p) => p.identity
    );

    setParticipants([localName, ...remoteNames]);
  }

  function cleanupAudioElements() {
    audioElementsRef.current.forEach((element) => {
      element.remove();
    });

    audioElementsRef.current = [];
  }

  function handleLogin(user) {
    setCurrentUser(user);
    setWelcomeUser(user);

    window.setTimeout(() => {
      setWelcomeUser(null);
    }, 6000);
  }

  async function leaveCurrentChannel() {
    const oldRoom = roomRef.current;

    if (oldRoom) {
      oldRoom.disconnect();
    }

    cleanupAudioElements();

    roomRef.current = null;
    setConnected(false);
    setMuted(false);
    setParticipants([]);
    setActiveSpeakers([]);
    setMessages([]);
    setCurrentChannel(null);

    await fetchChannels();
  }

  async function logout() {
  try {
    const room = roomRef.current;

    if (room) {
      room.disconnect();
    }

    cleanupAudioElements();

    roomRef.current = null;

    setConnected(false);
    setMuted(false);
    setParticipants([]);
    setActiveSpeakers([]);
    setMessages([]);
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

    try {
      if (roomRef.current) {
        roomRef.current.disconnect();
        cleanupAudioElements();
      }

      setCurrentChannel(channel);
      setConnected(false);
      setMuted(false);
      setParticipants([]);
      setActiveSpeakers([]);
      setMessages([]);

      const tokenUrl =
        `${API_BASE}/api/token` +
        `?room=${encodeURIComponent(channel.id)}`;

      const response = await fetch(
        tokenUrl,
        {
          credentials: "include",
        }
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "获取 token 失败");
      }

      if (!data.token || !data.url) {
        throw new Error("后端没有返回 token 或 url");
      }

      const room = new Room();

      room.on(RoomEvent.Connected, () => {
        refreshParticipants(room);
        fetchChannels();
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        refreshParticipants(room);
        fetchChannels();
      });

      room.on(RoomEvent.ParticipantDisconnected, () => {
        refreshParticipants(room);
        fetchChannels();
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const names = speakers.map((speaker) => speaker.identity);
        setActiveSpeakers(names);
      });

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const audioElement = track.attach();

          audioElement.autoplay = true;
          audioElement.controls = false;
          audioElement.style.display = "none";

          document.body.appendChild(audioElement);
          audioElementsRef.current.push(audioElement);
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => {
          element.remove();
        });
      });

      room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
        if (topic !== CHAT_TOPIC) return;

        try {
          const text = new TextDecoder().decode(payload);
          const message = JSON.parse(text);

          setMessages((prev) => [...prev, message]);
        } catch (error) {
          console.error("聊天消息解析失败：", error);
        }
      });

      await room.connect(data.url, data.token);
      await room.localParticipant.setMicrophoneEnabled(true);

      roomRef.current = room;

      setConnected(true);
      setMuted(false);
      refreshParticipants(room);
      await fetchChannels();
    } catch (error) {
      console.error("加入频道失败：", error);
      alert(`加入频道失败：${error.message}`);
    }
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;

    const nextMuted = !muted;

    await room.localParticipant.setMicrophoneEnabled(!nextMuted);

    setMuted(nextMuted);
  }

  async function sendMessage() {
    const room = roomRef.current;

    if (!room || !connected) {
      alert("请先加入一个语音频道");
      return;
    }

    const text = messageInput.trim();

    if (!text) return;

    const message = {
      sender: username,
      text,
      time: new Date().toLocaleTimeString(),
    };

    const payload = new TextEncoder().encode(JSON.stringify(message));

    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: CHAT_TOPIC,
    });

    setMessages((prev) => [...prev, message]);
    setMessageInput("");
  }

  function handleMessageKeyDown(e) {
    if (e.key === "Enter") {
      sendMessage();
    }
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
                  {currentUser.isCaptain
                    ? "NOVA 队长"
                    : currentUser.isGuest
                      ? "访客"
                      : "NOVA 战队成员"}
                </span>
              </div>

              <button
                type="button"
                className="logout-button"
                onClick={logout}
                title="退出登录"
              >
                退出
              </button>
            </div>
          </div>
        </aside>

        <main className="chat-panel">
          {!currentChannel ? (
            <div className="empty-state" />
          ) : (
            <>
              <header className="chat-header">
                <div>
                  <h1>{currentChannel.name}</h1>
                  <p>{connected ? "已连接语音频道" : "正在连接..."}</p>
                </div>

                <div className="header-actions">
                  <button onClick={toggleMute} disabled={!connected}>
                    {muted ? "取消静音" : "静音"}
                  </button>

                  <button
                    className="danger"
                    onClick={leaveCurrentChannel}
                    disabled={!connected}
                  >
                    退出频道
                  </button>
                </div>
              </header>

              <section className="content-area">
                <div className="messages-panel">
                  <div className="messages">
                    {messages.length === 0 ? (
                      <div className="no-message">暂无聊天消息</div>
                    ) : (
                      messages.map((message, index) => (
                        <div
                          key={index}
                          className={
                            message.sender === username
                              ? "message mine"
                              : "message"
                          }
                        >
                          <div className="message-meta">
                            <strong>{message.sender}</strong>
                            <span>{message.time}</span>
                          </div>

                          <div className="message-text">{message.text}</div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="message-input-row">
                    <input
                      placeholder="输入消息，按 Enter 发送"
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={handleMessageKeyDown}
                      disabled={!connected}
                    />

                    <button onClick={sendMessage} disabled={!connected}>
                      发送
                    </button>
                  </div>
                </div>

                <div className="users-panel">
                  <h3>当前频道</h3>

                  <div className="user-list">
                    {participants.map((name) => {
                      const isSpeaking = activeSpeakers.includes(name);
                      const isMe = name === username;

                      return (
                        <div
                          key={name}
                          className={isSpeaking ? "user speaking" : "user"}
                        >
                          <span>
                            {isSpeaking ? "🟢" : "⚪"} {name}
                            {isMe ? "（我）" : ""}
                          </span>

                          {isMe && muted && (
                            <small className="muted-tag">已静音</small>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            </>
          )}
        </main>
      </div>

       {welcomeUser && (
        <WelcomeOverlay
          user={welcomeUser}
        />
      )}

      {showTeamManagement &&
        currentUser.isCaptain && (
          <TeamManagement
            onClose={() =>
              setShowTeamManagement(false)
          }
        />
      )}
    </>
  );
}
