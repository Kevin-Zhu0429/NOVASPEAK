import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import AudioDevicePanel from "./AudioDevicePanel";
import ConnectionStatus from "./ConnectionStatus";
import NetworkStats from "./NetworkStats";
import VoiceControlBar from "./VoiceControlBar";
import VoiceParticipantList from "./VoiceParticipantList";
import MusicPanel from "../music/MusicPanel";
import ChatComposer from "../chat/ChatComposer";
import ChatMessageAttachment from "../chat/ChatMessageAttachment";
import useAudioDevices from "../../hooks/useAudioDevices";
import useLocalAudioPreferences from "../../hooks/useLocalAudioPreferences";
import useMicrophoneConstraints from "../../hooks/useMicrophoneConstraints";
import useTransientMessage from "../../hooks/useTransientMessage";
import useVoiceGate from "../../hooks/useVoiceGate";
import useVoiceNetworkStats from "../../hooks/useVoiceNetworkStats";
import { applyRemoteAudioPlaybackPreference, getMemberAudioKey, getMemberAudioPref } from "../../utils/local-audio-preferences";
import { getAudioCaptureDefaults, loadMicConstraints } from "../../utils/microphone-constraints";
import { MICROPHONE_RESTORED_MESSAGE, MICROPHONE_RESTORE_FAILED_MESSAGE, MICROPHONE_RESTORING_MESSAGE, getLocalServerMuteTransition, getServerMuteMicrophonePlan, isParticipantServerMuted, participantView } from "../../utils/voice-participant";
import { getDisconnectOutcome, resolveMovedChannel } from "../../utils/voice-room-events";
import { cleanupVoiceRoomAttempt, isVoiceRoomAttemptCurrent, shouldIgnoreConnectErrorForAttempt } from "../../utils/voice-room-lifecycle";
import { isNearChatBottom } from "../../utils/chat-scroll";
import { getChannelMessages, saveChannelAttachment, saveChannelMessage } from "../../utils/chat-api";
import {
  formatChatTime,
  mergeChatMessages,
  normalizeChatMessage,
  shouldShowChatTimeDivider,
} from "../../utils/chat-messages";

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
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [operationMessage, setOperationMessage] = useTransientMessage();
  const [participantBusy, setParticipantBusy] = useState("");
  const roomRef = useRef(null);
  const messagesRef = useRef(null);
  const messagesStickToBottomRef = useRef(true);
  const seenChatMessageIdsRef = useRef(new Set());
  const appendChatMessageRef = useRef(null);
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

  const scrollToLatestMessages = useCallback((behavior = "smooth") => {
    const container = messagesRef.current;
    if (!container) return;
    messagesStickToBottomRef.current = true;
    setUnreadMessageCount(0);
    container.scrollTo({ top: container.scrollHeight, behavior });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const container = messagesRef.current;
    if (!container) return;
    const nearBottom = isNearChatBottom(container);
    messagesStickToBottomRef.current = nearBottom;
    if (nearBottom) setUnreadMessageCount(0);
  }, []);

  const appendChatMessage = useCallback((raw, { own = false } = {}) => {
    const message = normalizeChatMessage(raw);
    if (!message) return false;
    if (message.id && seenChatMessageIdsRef.current.has(message.id)) return false;
    if (message.id) seenChatMessageIdsRef.current.add(message.id);
    if (own) {
      messagesStickToBottomRef.current = true;
      setUnreadMessageCount(0);
    } else if (!messagesStickToBottomRef.current) {
      setUnreadMessageCount((count) => count + 1);
    }
    setMessages((previous) => mergeChatMessages(previous, [message]));
    return true;
  }, []);

  useEffect(() => {
    appendChatMessageRef.current = appendChatMessage;
  }, [appendChatMessage]);

  useLayoutEffect(() => {
    if (messagesStickToBottomRef.current) scrollToLatestMessages("smooth");
  }, [messages, scrollToLatestMessages]);

  useEffect(() => {
    if (status !== "connected" && status !== "restored") return undefined;
    const controller = new AbortController();
    let retryTimer = null;
    let resolveRetry = null;
    const loadHistory = async () => {
      if (controller.signal.aborted) return;
      setChatHistoryLoading(true);
      setChatError("");
      try {
        let result = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            result = await getChannelMessages(apiBase, channel.id, {
              signal: controller.signal,
            });
            break;
          } catch (historyError) {
            if (
              historyError?.code !== "CHAT_NOT_IN_CHANNEL" ||
              attempt === 2 ||
              controller.signal.aborted
            ) {
              throw historyError;
            }
            // LiveKit 已连接后，Presence 频道位置可能晚几十毫秒到达后端。
            await new Promise((resolve) => {
              resolveRetry = resolve;
              retryTimer = setTimeout(() => {
                retryTimer = null;
                resolveRetry = null;
                resolve();
              }, 200);
            });
          }
        }
        if (controller.signal.aborted || !result) return;
        const history = Array.isArray(result.messages) ? result.messages : [];
        for (const message of history) {
          if (typeof message?.id === "string") {
            seenChatMessageIdsRef.current.add(message.id);
          }
        }
        setMessages((previous) => mergeChatMessages(history, previous));
      } catch (historyError) {
        if (historyError?.name !== "AbortError") {
          setChatError(historyError?.message || "加载聊天记录失败");
        }
      } finally {
        if (!controller.signal.aborted) setChatHistoryLoading(false);
      }
    };
    queueMicrotask(loadHistory);
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      resolveRetry?.();
    };
  }, [apiBase, channel.id, status]);

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
  }, [setOperationMessage]);

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
  }, [restoreMicrophoneAfterServerUnmute, setOperationMessage]);

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
  const voiceGate = useVoiceGate(room, microphoneEnabled);
  const localAudioPrefsRef = useRef(localAudioPrefs);

  // 将 Deafen + 本地偏好应用到所有已存在的远端音频元素：
  // Web Audio 模式用 RemoteAudioTrack GainNode 实现真实 0～200% 增益；
  // 不支持 Web Audio 时才安全降级到 element.volume（clamp 到 1）。
  const applyLocalAudioPrefs = useCallback(() => {
    for (const entry of audioElements.current.values()) {
      const pref = getMemberAudioPref(localAudioPrefsRef.current, getMemberAudioKey(entry.participantIdentity));
      const result = applyRemoteAudioPlaybackPreference({
        track: entry.track,
        element: entry.element,
        deafened: deafenRef.current,
        localMuted: pref.muted,
        volume: pref.volume,
        // AudioContext 可能在 TrackSubscribed 之后才准备好，每次都重新探测。
        webAudioEnabled: Boolean(entry.room?.audioContext),
      });
      entry.webAudioEnabled = result.webAudioEnabled;
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
    const activeRoom = new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true, audioCaptureDefaults: getAudioCaptureDefaults(loadMicConstraints()) });
    roomRef.current = activeRoom;
    voiceLifecycleDebug("connect-attempt-created", { attemptId, channelId: channel.id, roomIsCurrent: roomRef.current === activeRoom });
    queueMicrotask(() => {
      if (isVoiceRoomAttemptCurrent({ disposed, roomRef, room: activeRoom, connectAttemptRef, attemptId })) {
        setRoom(activeRoom);
        setStatus("connecting");
        setError("");
        messagesStickToBottomRef.current = true;
        seenChatMessageIdsRef.current.clear();
        setUnreadMessageCount(0);
        setChatHistoryLoading(true);
        setChatError("");
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
      const entry = { track, element, participantIdentity, room: activeRoom, webAudioEnabled: false };
      audioElements.current.set(publication.trackSid, entry);
      applyLocalAudioPrefs();
      document.body.appendChild(element);
      Promise.resolve(element.play())
        // LiveKit 可能在开始播放时才建立 Web Audio GainNode，播放成功后必须
        // 再应用一次保存值，避免滑块显示 10% 而实际音轨仍是默认增益。
        .then(() => { if (valid()) applyLocalAudioPrefs(); })
        .catch(() => valid() && setAudioBlocked(true));
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
        if (message && typeof message.text === "string") {
          appendChatMessageRef.current?.(message);
        }
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
      .on(RoomEvent.Connected, () => { if (valid()) { setStatus("connected"); sync(); applyLocalAudioPrefs(); onChannelsChangedRef.current?.(); onPresenceLocationChangeRef.current?.({ state: "in_channel", channelId: channel.id }); } })
      .on(RoomEvent.Reconnecting, () => { if (valid()) { setStatus("reconnecting"); setBaselineVersion((value) => value + 1); onPresenceLocationChangeRef.current?.({ state: "reconnecting", channelId: channel.id }); } })
      .on(RoomEvent.Reconnected, () => { if (valid()) { setStatus("restored"); setError(""); setBaselineVersion((value) => value + 1); sync(); applyLocalAudioPrefs(); onPresenceLocationChangeRef.current?.({ state: "in_channel", channelId: channel.id }); } })
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
      .on(RoomEvent.AudioPlaybackStatusChanged, (canPlayback) => {
        if (!valid()) return;
        setAudioBlocked(!canPlayback);
        if (canPlayback) applyLocalAudioPrefs();
      })
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
  }, [apiBase, channel.id, retryVersion, applyLocalAudioPrefs, cleanupAudio, syncParticipants]);

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
      applyLocalAudioPrefs();
      setAudioBlocked(false);
    } catch (playError) {
      console.error("启用音频失败：", playError);
      setAudioBlocked(true);
    }
  };

  const sendMessage = async ({ text = messageInput, files = [] } = {}) => {
    const normalizedText = text.trim();
    const pendingFiles = Array.isArray(files) ? files : [];
    const result = { textSent: false, sentFiles: 0 };
    if ((!normalizedText && pendingFiles.length === 0) || !roomRef.current || status === "reconnecting") return result;
    setChatError("");
    setChatSending(true);
    let realtimeSyncFailed = false;
    const acceptSavedMessage = async (saved) => {
      const message = saved?.message;
      if (!message) throw new Error("服务器返回了无效消息");
      appendChatMessageRef.current?.(message, { own: true });
      try {
        await roomRef.current.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: CHAT_TOPIC });
      } catch {
        realtimeSyncFailed = true;
      }
    };
    try {
      if (normalizedText) {
        await acceptSavedMessage(await saveChannelMessage(apiBase, channel.id, normalizedText));
        result.textSent = true;
        setMessageInput("");
      }
      for (const file of pendingFiles) {
        await acceptSavedMessage(await saveChannelAttachment(apiBase, channel.id, file));
        result.sentFiles += 1;
      }
      if (realtimeSyncFailed) setChatError("消息已保存，但实时同步暂时失败");
    } catch (sendError) {
      console.error("发送消息失败：", sendError);
      setChatError(sendError?.message || "消息发送失败");
    } finally {
      setChatSending(false);
    }
    return result;
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
          <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll}>
            {messages.length === 0 ? (
              <div className="no-message">{chatHistoryLoading ? "正在加载聊天记录……" : "暂无聊天消息"}</div>
            ) : messages.map((message, index) => (
              <Fragment key={message.id || `${message.createdAt}-${index}`}>
                {shouldShowChatTimeDivider(messages[index - 1], message) && (
                  <div className="chat-time-divider"><span>{formatChatTime(message.createdAt, { divider: true })}</span></div>
                )}
                <div className={message.sender === currentUser.displayName ? "message mine" : "message"}>
                  <div className="message-meta"><strong>{message.sender}</strong><span>{formatChatTime(message.createdAt)}</span></div>
                  {message.text && <div className="message-text">{message.text}</div>}
                  {message.attachment && <ChatMessageAttachment attachment={message.attachment} />}
                </div>
              </Fragment>
            ))}
          </div>
          {unreadMessageCount > 0 && (
            <button type="button" className="chat-new-message-button" onClick={() => scrollToLatestMessages("smooth")}>
              {unreadMessageCount} 条新消息 ↓
            </button>
          )}
          {chatError && <div className="chat-inline-error">{chatError}</div>}
          <ChatComposer value={messageInput} onChange={setMessageInput} onSend={sendMessage} disabled={controlsDisabled} sending={chatSending} />
        </section>
        <VoiceParticipantList apiBase={apiBase} participants={participants} participantLoss={networkStats.participantLoss} onlineMembers={onlineMembers} presenceStatus={presenceStatus} currentUser={currentUser} currentChannel={channel} channels={channels} participantBusy={participantBusy} onManageParticipant={manageParticipant} localAudioPrefs={localAudioPrefs} onSetMemberVolume={setMemberVolume} onSetMemberLocalMuted={setMemberLocalMuted} />
      </div>
      {devicesOpen && <AudioDevicePanel devices={devices} inputId={inputId} outputId={outputId} onInput={switchInput} onOutput={switchOutput} busy={busy} micConstraints={micConstraints} onToggleMicConstraint={toggleMicConstraint} micConstraintError={micConstraintError} voiceGate={voiceGate} />}
      {musicOpen && <MusicPanel apiBase={apiBase} channelId={channel.id} onClose={() => setMusicOpen(false)} />}
      <VoiceControlBar microphoneEnabled={microphoneEnabled} deafen={deafen} busy={busy} disabled={controlsDisabled} serverMuted={isParticipantServerMuted(room?.localParticipant)} devicesOpen={devicesOpen} musicOpen={musicOpen} onMicrophone={toggleMicrophone} onDeafen={toggleDeafen} onDevices={() => { setDevicesOpen((value) => { const next = !value; if (next) setMusicOpen(false); return next; }); }} onMusic={() => { setMusicOpen((value) => { const next = !value; if (next) setDevicesOpen(false); return next; }); }} onLeave={() => onLeave?.()} />
    </div>
  );
}
