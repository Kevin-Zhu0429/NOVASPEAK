import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionState, DisconnectReason, Room, RoomEvent, Track } from "livekit-client";
import AudioDevicePanel from "./AudioDevicePanel";
import ConnectionStatus from "./ConnectionStatus";
import NetworkStats from "./NetworkStats";
import VoiceControlBar from "./VoiceControlBar";
import VoiceParticipantList from "./VoiceParticipantList";
import useAudioDevices from "../../hooks/useAudioDevices";
import useVoiceNetworkStats from "../../hooks/useVoiceNetworkStats";
import { participantView } from "../../utils/voice-participant";

const CHAT_TOPIC = "nova-chat";

function microphoneError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") return "麦克风权限被拒绝";
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") return "未找到可用麦克风";
  return "无法控制麦克风";
}

export default function VoiceRoom({ channel, channels, currentUser, apiBase, onLeave, onMovedToChannel, onChannelsChanged, onPresenceLocationChange, onlineMembers, presenceStatus }) {
  const [room, setRoom] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState("");
  const [participants, setParticipants] = useState([]);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [deafen, setDeafen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [inputId, setInputId] = useState("");
  const [outputId, setOutputId] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [operationMessage, setOperationMessage] = useState("");
  const [participantBusy, setParticipantBusy] = useState("");
  const roomRef = useRef(null);
  const audioElements = useRef(new Map());
  const deafenRef = useRef(false);
  const restoreMicrophone = useRef(false);
  const generation = useRef(0);
  const devices = useAudioDevices(devicesOpen || Boolean(room));
  const refreshDevices = devices.refresh;
  const networkStats = useVoiceNetworkStats(room, status === "connected" || status === "restored", baselineVersion);

  const syncParticipants = useCallback((activeRoom) => {
    if (!activeRoom) return;
    setParticipants([
      participantView(activeRoom.localParticipant, true),
      ...Array.from(activeRoom.remoteParticipants.values()).map((participant) => participantView(participant)),
    ]);
  }, []);

  const cleanupAudio = useCallback(() => {
    for (const { track, element } of audioElements.current.values()) {
      track.detach(element);
      element.remove();
    }
    audioElements.current.clear();
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const activeRoom = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = activeRoom;
    queueMicrotask(() => {
      if (generation.current === currentGeneration) {
        setRoom(activeRoom);
        setStatus("connecting");
        setError("");
        setMessages([]);
      }
    });

    const valid = () => generation.current === currentGeneration;
    const sync = () => valid() && syncParticipants(activeRoom);
    const attachAudio = (track, publication) => {
      if (track.kind !== Track.Kind.Audio || audioElements.current.has(publication.trackSid)) return;
      const element = track.attach();
      element.autoplay = true;
      element.controls = false;
      element.className = "voice-remote-audio";
      element.muted = deafenRef.current;
      document.body.appendChild(element);
      audioElements.current.set(publication.trackSid, { track, element });
      element.play().catch(() => valid() && setAudioBlocked(true));
    };
    const detachAudio = (track, publication) => {
      const entry = audioElements.current.get(publication.trackSid);
      if (entry) {
        track.detach(entry.element);
        entry.element.remove();
        audioElements.current.delete(publication.trackSid);
      }
    };
    const onData = (payload, participant, kind, topic) => {
      if (topic !== CHAT_TOPIC || !valid()) return;
      try {
        const message = JSON.parse(new TextDecoder().decode(payload));
        if (message && typeof message.text === "string") setMessages((previous) => [...previous, message]);
      } catch (dataError) {
        console.error("聊天消息解析失败：", dataError);
      }
    };
    const onDisconnected = (reason) => {
      if (!valid()) return;
      setStatus("failed");
      setError(reason === DisconnectReason.PARTICIPANT_REMOVED ? "你已被移出语音频道" : "连接已断开");
      setMicrophoneEnabled(false);
      cleanupAudio();
      onPresenceLocationChange({ state: "lobby", channelId: null });
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) onLeave?.("你已被移出语音频道");
    };

    activeRoom
      .on(RoomEvent.Connected, () => { if (valid()) { setStatus("connected"); sync(); onChannelsChanged(); onPresenceLocationChange({ state: "in_channel", channelId: channel.id }); } })
      .on(RoomEvent.Reconnecting, () => { if (valid()) { setStatus("reconnecting"); setBaselineVersion((value) => value + 1); onPresenceLocationChange({ state: "reconnecting", channelId: channel.id }); } })
      .on(RoomEvent.Reconnected, () => { if (valid()) { setStatus("restored"); setError(""); setBaselineVersion((value) => value + 1); sync(); onPresenceLocationChange({ state: "in_channel", channelId: channel.id }); } })
      .on(RoomEvent.Moved, () => { if (valid()) { const targetId = activeRoom.name; const target = channels.find((item) => item.id === targetId); if (target) onMovedToChannel?.(target.id, `你已被移动到“${target.name}”`); } })
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.ParticipantConnected, sync)
      .on(RoomEvent.ParticipantDisconnected, sync)
      .on(RoomEvent.ActiveSpeakersChanged, sync)
      .on(RoomEvent.ConnectionQualityChanged, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync)
      .on(RoomEvent.TrackPublished, sync)
      .on(RoomEvent.TrackUnpublished, sync)
      .on(RoomEvent.ParticipantPermissionsChanged, () => { sync(); const local = activeRoom.localParticipant; if (local?.permissions?.canPublish === false) { setMicrophoneEnabled(false); setOperationMessage("你已被服务器静音"); } else { setOperationMessage("服务器静音已解除，请自行开启麦克风"); } })
      .on(RoomEvent.TrackSubscribed, (track, publication) => { attachAudio(track, publication); sync(); })
      .on(RoomEvent.TrackUnsubscribed, (track, publication) => { detachAudio(track, publication); sync(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, (canPlayback) => valid() && setAudioBlocked(!canPlayback))
      .on(RoomEvent.DataReceived, onData);

    (async () => {
      try {
        const response = await fetch(`${apiBase}/api/token?room=${encodeURIComponent(channel.id)}`, { credentials: "include" });
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) throw new Error("语音服务返回了无效响应");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法获取语音凭证");
        if (!data.token || !data.url) throw new Error("语音服务配置不完整");
        if (!valid()) return;
        await activeRoom.connect(data.url, data.token);
        if (!valid()) { activeRoom.disconnect(); return; }
        try {
          await activeRoom.localParticipant.setMicrophoneEnabled(true);
          if (valid()) setMicrophoneEnabled(true);
        } catch (micError) {
          console.error("麦克风启用失败：", micError);
          if (valid()) setError(microphoneError(micError));
        }
        refreshDevices();
        sync();
      } catch (connectError) {
        console.error("连接语音频道失败：", connectError);
        if (valid()) {
          setStatus("failed");
          setError(connectError.message || "无法连接语音频道");
        }
      }
    })();

    return () => {
      generation.current += 1;
      activeRoom.removeAllListeners();
      cleanupAudio();
      if (activeRoom.state !== ConnectionState.Disconnected) activeRoom.disconnect();
      onPresenceLocationChange({ state: "lobby", channelId: null });
      if (reason === DisconnectReason.PARTICIPANT_REMOVED) onLeave?.("你已被移出语音频道");
      if (roomRef.current === activeRoom) roomRef.current = null;
    };
  }, [apiBase, channel.id, cleanupAudio, refreshDevices, onChannelsChanged, onPresenceLocationChange, retryVersion, syncParticipants]);

  const toggleMicrophone = async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    setBusy(true);
    setError("");
    try {
      const next = !microphoneEnabled;
      if (activeRoom.localParticipant?.permissions?.canPublish === false) throw new Error("你已被服务器静音");
      await activeRoom.localParticipant.setMicrophoneEnabled(next);
      setMicrophoneEnabled(next);
      syncParticipants(activeRoom);
      if (next) refreshDevices();
    } catch (micError) {
      console.error("麦克风控制失败：", micError);
      setError(microphoneError(micError));
    } finally { setBusy(false); }
  };

  const toggleDeafen = async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    setBusy(true);
    setError("");
    try {
      if (!deafenRef.current) {
        restoreMicrophone.current = microphoneEnabled;
        if (microphoneEnabled) await activeRoom.localParticipant.setMicrophoneEnabled(false);
        for (const { element } of audioElements.current.values()) element.muted = true;
        deafenRef.current = true;
        setDeafen(true);
        setMicrophoneEnabled(false);
      } else {
        for (const { element } of audioElements.current.values()) element.muted = false;
        deafenRef.current = false;
        setDeafen(false);
        if (restoreMicrophone.current) {
          await activeRoom.localParticipant.setMicrophoneEnabled(true);
          setMicrophoneEnabled(true);
        }
      }
      syncParticipants(activeRoom);
    } catch (controlError) {
      console.error("耳机静音切换失败：", controlError);
      setError("无法切换耳机静音状态");
    } finally { setBusy(false); }
  };

  const switchInput = async (deviceId) => {
    if (!roomRef.current || !deviceId) return;
    setBusy(true);
    try {
      await roomRef.current.switchActiveDevice("audioinput", deviceId);
      setInputId(deviceId);
      setBaselineVersion((value) => value + 1);
      syncParticipants(roomRef.current);
    } catch (deviceError) {
      console.error("切换麦克风失败：", deviceError);
      setError("无法切换麦克风");
    } finally { setBusy(false); }
  };

  const switchOutput = async (deviceId) => {
    if (!roomRef.current || !deviceId) return;
    if (!devices.outputSupported) { setError("当前浏览器不支持切换扬声器"); return; }
    setBusy(true);
    try {
      await roomRef.current.switchActiveDevice("audiooutput", deviceId);
      setOutputId(deviceId);
    } catch (deviceError) {
      console.error("切换扬声器失败：", deviceError);
      setError("无法切换扬声器");
    } finally { setBusy(false); }
  };

  const enableAudio = async () => {
    try {
      await roomRef.current?.startAudio();
      for (const { element } of audioElements.current.values()) await element.play();
      setAudioBlocked(false);
    } catch (playError) {
      console.error("启用音频失败：", playError);
      setAudioBlocked(true);
    }
  };

  const sendMessage = async () => {
    const text = messageInput.trim();
    if (!text || !roomRef.current || status === "reconnecting") return;
    const message = { sender: currentUser.displayName, text, time: new Date().toLocaleTimeString() };
    try {
      await roomRef.current.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CHAT_TOPIC });
      setMessages((previous) => [...previous, message]);
      setMessageInput("");
    } catch (sendError) {
      console.error("发送消息失败：", sendError);
      setError("消息发送失败");
    }
  };


  const manageParticipant = async (action, participant, targetChannelId) => {
    if (!participant?.id || participantBusy) return;
    setParticipantBusy(participant.id);
    setError("");
    setOperationMessage("");
    try {
      const response = await fetch(`${apiBase}/api/voice/participants/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sourceChannelId: channel.id, participantIdentity: participant.id, targetChannelId }),
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("服务器返回了无效响应");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "成员操作失败");
      setOperationMessage(data.message || "操作成功");
      await onChannelsChanged();
    } catch (operationError) {
      console.error("成员语音管理失败：", operationError);
      setError(operationError.message || "成员操作失败");
    } finally {
      setParticipantBusy("");
    }
  };

  const controlsDisabled = status === "connecting" || status === "reconnecting" || status === "failed";
  return (
    <div className="voice-room">
      <header className="voice-room-header">
        <div><span className="voice-eyebrow">VOICE CHANNEL</span><h1>{channel.name}</h1><ConnectionStatus status={status} error={error} audioBlocked={audioBlocked} onEnableAudio={enableAudio} onReconnect={() => setRetryVersion((value) => value + 1)} onLeave={onLeave} /></div>
        <NetworkStats stats={networkStats} quality={room?.localParticipant.connectionQuality} />
      </header>
      {operationMessage && <div className="voice-operation-message">{operationMessage}</div>}
      <div className="voice-room-content">
        <section className="voice-chat-panel">
          <div className="messages">
            {messages.length === 0 ? <div className="no-message">暂无聊天消息</div> : messages.map((message, index) => (
              <div key={`${message.time}-${index}`} className={message.sender === currentUser.displayName ? "message mine" : "message"}>
                <div className="message-meta"><strong>{message.sender}</strong><span>{message.time}</span></div><div className="message-text">{message.text}</div>
              </div>
            ))}
          </div>
          <div className="message-input-row"><input value={messageInput} onChange={(event) => setMessageInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendMessage(); }} placeholder="输入消息，按 Enter 发送" disabled={controlsDisabled} /><button type="button" onClick={sendMessage} disabled={controlsDisabled}>发送</button></div>
        </section>
        <VoiceParticipantList participants={participants} participantLoss={networkStats.participantLoss} onlineMembers={onlineMembers} presenceStatus={presenceStatus} currentUser={currentUser} currentChannel={channel} channels={channels} participantBusy={participantBusy} onManageParticipant={manageParticipant} />
      </div>
      {devicesOpen && <AudioDevicePanel devices={devices} inputId={inputId} outputId={outputId} onInput={switchInput} onOutput={switchOutput} busy={busy} />}
      <VoiceControlBar microphoneEnabled={microphoneEnabled} deafen={deafen} busy={busy} disabled={controlsDisabled} serverMuted={room?.localParticipant?.permissions?.canPublish === false} devicesOpen={devicesOpen} onMicrophone={toggleMicrophone} onDeafen={toggleDeafen} onDevices={() => setDevicesOpen((value) => !value)} onLeave={onLeave} />
    </div>
  );
}
