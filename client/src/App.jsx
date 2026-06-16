import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import ChannelList from "./components/ChannelList";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const CHAT_TOPIC = "nova-chat";

export default function App() {
  const [username, setUsername] = useState("");
  const [entered, setEntered] = useState(false);

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

  useEffect(() => {
    if (!entered) return;

    fetchChannels();

    const timer = setInterval(() => {
      fetchChannels();
    }, 3000);

    return () => clearInterval(timer);
  }, [entered]);

  async function fetchChannels() {
    try {
      const response = await fetch( `${API_BASE}/api/channels`);
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

  function enterApp() {
    if (!username.trim()) {
      alert("请先输入昵称");
      return;
    }

    setEntered(true);
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

      const tokenUrl = `${API_BASE}/api/token?room=${encodeURIComponent(
        channel.id
      )}&username=${encodeURIComponent(username)}`;

      const response = await fetch(tokenUrl);
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

  if (!entered) {
    return (
      <div className="login-page">
        <div className="login-card">
          <h1>NovaSpeak</h1>
          <p>极简开黑语音软件</p>

          <input
            placeholder="输入你的昵称"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enterApp();
            }}
          />

          <button onClick={enterApp}>进入聊天室</button>
        </div>
      </div>
    );
  }

  return (
    <div className="main-layout">
      <aside className="sidebar">
        <div className="brand">
          <h2>NovaSpeak</h2>
          <span>{username}</span>
        </div>

        <ChannelList
          channels={channels}
          currentChannel={currentChannel}
          onJoinChannel={joinChannel}
          onCreateChannel={createChannel}
        />
      </aside>

      <main className="chat-panel">
        {!currentChannel ? (
          <div className="empty-state">
            <h1>选择一个语音频道</h1>
            <p>从左侧点击频道后，就可以进入语音聊天室。</p>
          </div>
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
  );
}