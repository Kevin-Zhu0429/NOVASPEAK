import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import AudioDevicePanel from "./AudioDevicePanel";
import ConnectionStatus from "./ConnectionStatus";
import NetworkStats from "./NetworkStats";
import VoiceControlBar from "./VoiceControlBar";
import VoiceParticipantList from "./VoiceParticipantList";
import MusicPanel from "../music/MusicPanel";
import useAudioDevices from "../../hooks/useAudioDevices";
import useLocalAudioPreferences from "../../hooks/useLocalAudioPreferences";
import useMicrophoneConstraints from "../../hooks/useMicrophoneConstraints";
import useVoiceNetworkStats from "../../hooks/useVoiceNetworkStats";
import { getAudioElementPatch, getMemberAudioKey, getMemberAudioPref } from "../../utils/local-audio-preferences";
import { getAudioCaptureDefaults, loadMicConstraints } from "../../utils/microphone-constraints";
import { MICROPHONE_RESTORED_MESSAGE, MICROPHONE_RESTORE_FAILED_MESSAGE, MICROPHONE_RESTORING_MESSAGE, getLocalServerMuteTransition, getServerMuteMicrophonePlan, isParticipantServerMuted, participantView } from "../../utils/voice-participant";
import { getDisconnectOutcome, resolveMovedChannel } from "../../utils/voice-room-events";
import { cleanupVoiceRoomAttempt, isVoiceRoomAttemptCurrent, shouldIgnoreConnectErrorForAttempt } from "../../utils/voice-room-lifecycle";

const CHAT_TOPIC = "nova-chat";

function voiceLifecycleDebug(label, details) {
  if (typeof window === "undefined" || window.localStorage?.getItem("novaVoiceDebug") !== "1") return;
  console.debug(`[voice-room] ${label}`, details);
}

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
  const [musicOpen, setMusicOpen] = useState(false);
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
  const connectAttemptRef = useRef(0);
  const movedRef = useRef(false);
  const disconnectReasonRef = useRef("");
  const channelsRef = useRef(channels);
  const onLeaveRef = useRef(onLeave);
  const onMovedToChannelRef = useRef(onMovedToChannel);
  const onChannelsChangedRef = useRef(onChannelsChanged);
  const onPresenceLocationChangeRef = useRef(onPresenceLocationChange);
  const refreshDevicesRef = useRef(null);
  const devices = useAudioDevices(devicesOpen || Boolean(room));
  const refreshDevices = devices.refresh;
  const previousLocalServerMutedRef = useRef(null);
  const localServerMuteInitializedRef = useRef(false);
  const microphoneEnabledRef = useRef(false);
  const wasMicEnabledBeforeServerMuteRef = useRef(null);
  const voiceConnectionIdRef = useRef(null);
  if (!voiceConnectionIdRef.current) {
    const storageKey = "novaVoiceConnectionId";
    const existing = typeof window !== "undefined" ? window.sessionStorage?.getItem(storageKey) : "";
    voiceConnectionIdRef.current = existing || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (typeof window !== "undefined" && !existing) window.sessionStorage?.setItem(storageKey, voiceConnectionIdRef.current);
  }
  const networkStats = useVoiceNetworkStats(room, status === "connected" || status === "restored", baselineVersion);


  useEffect(() => { channelsRef.current = channels; }, [channels]);
  useEffect(() => { onLeaveRef.current = onLeave; }, [onLeave]);
  useEffect(() => { onMovedToChannelRef.current = onMovedToChannel; }, [onMovedToChannel]);
  useEffect(() => { onChannelsChangedRef.current = onChannelsChanged; }, [onChannelsChanged]);
  useEffect(() => { onPresenceLocationChangeRef.current = onPresenceLocationChange; }, [onPresenceLocationChange]);
  useEffect(() => { refreshDevicesRef.current = refreshDevices; }, [refreshDevices]);
  useEffect(() => { microphoneEnabledRef.current = microphoneEnabled; }, [microphoneEnabled]);

  // 解除服务器静音后恢复麦克风：LiveKit permission/metadata 恢复有短暂延迟，
  // 轻量延迟 + 最多 3 次重试；房间切换、Deafen、再次被禁音时中止。
  const restoreMicrophoneAfterServerUnmute = useCallback(async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 150));
      if (roomRef.current !== activeRoom) return;
      if (deafenRef.current) return;
      if (isParticipantServerMuted(activeRoom.localParticipant)) return;
      try {
        await activeRoom.localParticipant.setMicrophoneEnabled(true);
        if (roomRef.current !== activeRoom) return;
        setMicrophoneEnabled(true);
        setOperationMessage(MICROPHONE_RESTORED_MESSAGE);
        return;
      } catch (restoreError) {
        console.error("解除服务器静音后恢复麦克风失败：", restoreError);
      }
    }
    if (roomRef.current === activeRoom) setOperationMessage(MICROPHONE_RESTORE_FAILED_MESSAGE);
  }, []);

  const syncLocalServerMuteStatus = useCallback((activeRoom, { notify = false } = {}) => {
    if (!activeRoom?.localParticipant) return false;
    const current = isParticipantServerMuted(activeRoom.localParticipant);
    const transition = getLocalServerMuteTransition(previousLocalServerMutedRef.current, current, localServerMuteInitializedRef.current);
    const plan = getServerMuteMicrophonePlan({
      isLocal: true,
      previousServerMuted: previousLocalServerMutedRef.current === true,
      currentServerMuted: current,
      microphoneEnabled: microphoneEnabledRef.current,
      rememberedMicEnabled: wasMicEnabledBeforeServerMuteRef.current,
    });
    previousLocalServerMutedRef.current = transition.current;
    localServerMuteInitializedRef.current = true;
    wasMicEnabledBeforeServerMuteRef.current = plan.rememberedMicEnabled;
    if (transition.current) setMicrophoneEnabled(false);
    const shouldRestore = plan.shouldRestoreMicrophone && !deafenRef.current;
    if (notify && transition.message) setOperationMessage(shouldRestore ? MICROPHONE_RESTORING_MESSAGE : transition.message);
    if (shouldRestore) restoreMicrophoneAfterServerUnmute();
    return transition.current;
  }, [restoreMicrophoneAfterServerUnmute]);

  const syncParticipants = useCallback((activeRoom, options = {}) => {
    if (!activeRoom) return;
    syncLocalServerMuteStatus(activeRoom, options);
    setParticipants([
      participantView(activeRoom.localParticipant, true),
      ...Array.from(activeRoom.remoteParticipants.values()).map((participant) => participantView(participant)),
    ]);
  }, [syncLocalServerMuteStatus]);

  const cleanupAudio = useCallback(() => {
    for (const { track, element } of audioElements.current.values()) {
      track.detach(element);
      element.remove();
    }
    audioElements.current.clear();
  }, []);

  const { prefs: localAudioPrefs, setMemberVolume, setMemberLocalMuted } = useLocalAudioPreferences();
  const { constraints: micConstraints, toggleConstraint: toggleMicConstraint, applyError: micConstraintError } = useMicrophoneConstraints(room);
  const localAudioPrefsRef = useRef(localAudioPrefs);

  // 将 Deafen + 本地偏好应用到所有已存在的远端音频元素：
  // muted 只由 Deafen 控制，本地静音/单成员音量映射到 element.volume（clamp 到 1）。
  const applyLocalAudioPrefs = useCallback(() => {
    for (const entry of audioElements.current.values()) {
      const pref = getMemberAudioPref(localAudioPrefsRef.current, getMemberAudioKey(entry.participantIdentity));
      const patch = getAudioElementPatch({ deafened: deafenRef.current, localMuted: pref.muted, volume: pref.volume });
      entry.element.muted = patch.muted;
      entry.element.volume = patch.volume;
    }
  }, []);

  useEffect(() => {
    localAudioPrefsRef.current = localAudioPrefs;
    applyLocalAudioPrefs();
  }, [localAudioPrefs, applyLocalAudioPrefs]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const attemptId = ++connectAttemptRef.current;
    let disposed = false;
    movedRef.current = false;
    disconnectReasonRef.current = "connect-attempt-created";
    const activeRoom = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: getAudioCaptureDefaults(loadMicConstraints()) });
    roomRef.current = activeRoom;
    voiceLifecycleDebug("connect-attempt-created", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom });
    queueMicrotask(() => {
      if (isVoiceRoomAttemptCurrent({ disposed, roomRef, room: activeRoom, connectAttemptRef, attemptId })) {
        setRoom(activeRoom);
        setStatus("connecting");
        setError("");
        setMessages([]);
      }
    });

    const valid = () => generation.current === currentGeneration && isVoiceRoomAttemptCurrent({ disposed, roomRef, room: activeRoom, connectAttemptRef, attemptId });
    const sync = (options = {}) => valid() && syncParticipants(activeRoom, options);
    const attachAudio = (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio || audioElements.current.has(publication.trackSid)) return;
      const element = track.attach();
      element.autoplay = true;
      element.controls = false;
      element.className = "voice-remote-audio";
      const participantIdentity = participant?.identity || "";
      const pref = getMemberAudioPref(localAudioPrefsRef.current, getMemberAudioKey(participantIdentity));
      const patch = getAudioElementPatch({ deafened: deafenRef.current, localMuted: pref.muted, volume: pref.volume });
      element.muted = patch.muted;
      element.volume = patch.volume;
      document.body.appendChild(element);
      audioElements.current.set(publication.trackSid, { track, element, participantIdentity });
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
    const onDisconnected = (disconnectReason) => {
      if (disposed || !valid()) return;
      const outcome = getDisconnectOutcome(disconnectReason, { moved: movedRef.current, roomMatches: roomRef.current === activeRoom });
      if (outcome.action === "ignore") return;
      setStatus("failed");
      setError(outcome.message || "");
      setMicrophoneEnabled(false);
      cleanupAudio();
      onPresenceLocationChangeRef.current?.({ state: "lobby", channelId: null });
      if (outcome.removed) onLeaveRef.current?.(outcome.message);
    };
    const onMoved = (targetRoomName) => {
      if (!valid()) return;
      const target = resolveMovedChannel(targetRoomName || activeRoom.name, channelsRef.current);
      if (!target) return;
      movedRef.current = true;
      setError("");
      setStatus("connected");
      onMovedToChannelRef.current?.(target.id, `你已被移动到“${target.name}”`);
      onPresenceLocationChangeRef.current?.({ state: "in_channel", channelId: target.id });
    };

    activeRoom
      .on(RoomEvent.Connected, () => { if (valid()) { setStatus("connected"); sync(); onChannelsChangedRef.current?.(); onPresenceLocationChangeRef.current?.({ state: "in_channel", channelId: channel.id }); } })
      .on(RoomEvent.Reconnecting, () => { if (valid()) { setStatus("reconnecting"); setBaselineVersion((value) => value + 1); onPresenceLocationChangeRef.current?.({ state: "reconnecting", channelId: channel.id }); } })
      .on(RoomEvent.Reconnected, () => { if (valid()) { setStatus("restored"); setError(""); setBaselineVersion((value) => value + 1); sync(); onPresenceLocationChangeRef.current?.({ state: "in_channel", channelId: channel.id }); } })
      .on(RoomEvent.Moved, onMoved)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.ParticipantConnected, sync)
      .on(RoomEvent.ParticipantDisconnected, sync)
      .on(RoomEvent.ActiveSpeakersChanged, sync)
      .on(RoomEvent.ConnectionQualityChanged, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync)
      .on(RoomEvent.TrackPublished, sync)
      .on(RoomEvent.TrackUnpublished, sync)
      .on(RoomEvent.ParticipantMetadataChanged, (metadata, participant) => sync({ notify: participant?.isLocal === true || participant === activeRoom.localParticipant }))
      .on(RoomEvent.ParticipantPermissionsChanged, (participant) => { if (!valid()) return; sync({ notify: participant?.isLocal === true || participant === activeRoom.localParticipant }); })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => { if (!valid()) return; attachAudio(track, publication, participant); sync(); })
      .on(RoomEvent.TrackUnsubscribed, (track, publication) => { if (!valid()) return; detachAudio(track, publication); sync(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, (canPlayback) => valid() && setAudioBlocked(!canPlayback))
      .on(RoomEvent.DataReceived, onData);

    (async () => {
      try {
        disconnectReasonRef.current = "connect-start";
        voiceLifecycleDebug("connect-start", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom });
        const response = await fetch(`${apiBase}/api/token?room=${encodeURIComponent(channel.id)}&voiceConnectionId=${encodeURIComponent(voiceConnectionIdRef.current)}`, { credentials: "include" });
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) throw new Error("语音服务返回了无效响应");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法获取语音凭证");
        if (!data.token || !data.url) throw new Error("语音服务配置不完整");
        if (!valid()) return;
        await activeRoom.connect(data.url, data.token);
        syncLocalServerMuteStatus(activeRoom, { notify: false });
        if (!valid()) return;
        disconnectReasonRef.current = "connect-resolved";
        voiceLifecycleDebug("connect-resolved", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom });
        try {
          await activeRoom.localParticipant.setMicrophoneEnabled(true);
          if (valid()) setMicrophoneEnabled(true);
        } catch (micError) {
          console.error("麦克风启用失败：", micError);
          if (valid()) setError(microphoneError(micError));
        }
        refreshDevicesRef.current?.();
        sync();
      } catch (connectError) {
        if (shouldIgnoreConnectErrorForAttempt({ disposed, roomRef, room: activeRoom, connectAttemptRef, attemptId })) return;
        disconnectReasonRef.current = "connect-rejected";
        voiceLifecycleDebug("connect-rejected", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom, message: connectError?.message });
        console.error("连接语音频道失败：", connectError);
        setStatus("failed");
        setError(connectError.message || "无法连接语音频道");
      }
    })();

    return () => {
      disposed = true;
      generation.current += 1;
      disconnectReasonRef.current = "effect-cleanup";
      voiceLifecycleDebug("effect-cleanup", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom, reason: "effect-cleanup" });
      activeRoom.off(RoomEvent.Moved, onMoved);
      activeRoom.off(RoomEvent.Disconnected, onDisconnected);
      activeRoom.removeAllListeners();
      cleanupAudio();
      const disconnected = cleanupVoiceRoomAttempt({ room: activeRoom, roomRef, disconnectReasonRef, reason: "effect-cleanup" });
      if (disconnected) voiceLifecycleDebug("disconnect-called", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom, reason: "effect-cleanup" });
    };
  }, [apiBase, channel.id, retryVersion, cleanupAudio, syncParticipants]);

  const toggleMicrophone = async () => {
    const activeRoom = roomRef.current;
    if (!activeRoom) return;
    setBusy(true);
    setError("");
    try {
      const next = !microphoneEnabled;
      if (isParticipantServerMuted(activeRoom.localParticipant)) throw new Error("你已被服务器静音");
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
        deafenRef.current = true;
        applyLocalAudioPrefs();
        setDeafen(true);
        setMicrophoneEnabled(false);
      } else {
        deafenRef.current = false;
        applyLocalAudioPrefs();
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
      if ((action === "mute" || action === "unmute") && typeof data.serverMuted === "boolean") {
        setParticipants((previous) => previous.map((item) => item.id === participant.id ? { ...item, serverMuted: data.serverMuted } : item));
      }
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
        <div><span className="voice-eyebrow">VOICE CHANNEL</span><h1>{channel.name}</h1><ConnectionStatus status={status} error={error} audioBlocked={audioBlocked} onEnableAudio={enableAudio} onReconnect={() => setRetryVersion((value) => value + 1)} onLeave={() => onLeave?.()} /></div>
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
        <VoiceParticipantList participants={participants} participantLoss={networkStats.participantLoss} onlineMembers={onlineMembers} presenceStatus={presenceStatus} currentUser={currentUser} currentChannel={channel} channels={channels} participantBusy={participantBusy} onManageParticipant={manageParticipant} localAudioPrefs={localAudioPrefs} onSetMemberVolume={setMemberVolume} onSetMemberLocalMuted={setMemberLocalMuted} />
      </div>
      {devicesOpen && <AudioDevicePanel devices={devices} inputId={inputId} outputId={outputId} onInput={switchInput} onOutput={switchOutput} busy={busy} micConstraints={micConstraints} onToggleMicConstraint={toggleMicConstraint} micConstraintError={micConstraintError} />}
      {musicOpen && <MusicPanel apiBase={apiBase} onClose={() => setMusicOpen(false)} />}
      <VoiceControlBar microphoneEnabled={microphoneEnabled} deafen={deafen} busy={busy} disabled={controlsDisabled} serverMuted={isParticipantServerMuted(room?.localParticipant)} devicesOpen={devicesOpen} musicOpen={musicOpen} onMicrophone={toggleMicrophone} onDeafen={toggleDeafen} onDevices={() => { setDevicesOpen((value) => { const next = !value; if (next) setMusicOpen(false); return next; }); }} onMusic={() => { setMusicOpen((value) => { const next = !value; if (next) setDevicesOpen(false); return next; }); }} onLeave={() => onLeave?.()} />
    </div>
  );
}
