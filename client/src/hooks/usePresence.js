import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildPresenceWebSocketUrl,
  clearPresenceConnectedMarker,
  markPresenceConnected,
  parsePresenceMessage,
  shouldClaimFreshPresenceLogin,
  sortPresenceMembers,
} from "../utils/presence-display";

export default function usePresence(currentUser, apiBase = "", onAnnouncement, onVoiceControl) {
  const [members, setMembers] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const attemptRef = useRef(0);
  const activeRef = useRef(false);
  const locationRef = useRef({ state: "lobby", channelId: null });
  const onAnnouncementRef = useRef(onAnnouncement);
  const onVoiceControlRef = useRef(onVoiceControl);

  useEffect(() => { onAnnouncementRef.current = onAnnouncement; }, [onAnnouncement]);
  useEffect(() => { onVoiceControlRef.current = onVoiceControl; }, [onVoiceControl]);

  const setLocation = useCallback((location) => {
    locationRef.current = location;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "presence:set-location", ...location }));
    }
  }, []);

  useEffect(() => {
    if (!currentUser) {
      activeRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      clearTimeout(retryRef.current);
      // 登出后本标签页重新登录算真实新登录，允许再次声明 fresh
      clearPresenceConnectedMarker();
      queueMicrotask(() => {
        setMembers([]);
        setConnectionStatus("offline");
      });
      return undefined;
    }
    activeRef.current = true;
    let generation = 0;
    const connect = () => {
      if (!activeRef.current) return;
      const ownGeneration = ++generation;
      setConnectionStatus(attemptRef.current ? "reconnecting" : "connecting");
      const socket = new WebSocket(buildPresenceWebSocketUrl(apiBase, window.location, { freshLogin: shouldClaimFreshPresenceLogin() }));
      socketRef.current = socket;
      socket.onopen = () => {
        if (ownGeneration !== generation || socketRef.current !== socket) return socket.close();
        attemptRef.current = 0;
        markPresenceConnected();
        setConnectionStatus("online");
        socket.send(JSON.stringify({ type: "presence:set-location", ...locationRef.current }));
      };
      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        const snapshot = parsePresenceMessage(event.data);
        if (snapshot) {
          setMembers(sortPresenceMembers(snapshot));
          return;
        }
        // 同一条 Presence 连接同时承载 announcement 与 voice_control，
        // 两个处理器各自解析自己认识的消息类型，互不误触发
        onVoiceControlRef.current?.(event.data);
        onAnnouncementRef.current?.(event.data);
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket || !activeRef.current) return;
        socketRef.current = null;
        if (event.code === 4401 || event.code === 4403) {
          setConnectionStatus("unavailable");
          return;
        }
        setConnectionStatus("reconnecting");
        const delay = Math.min(1000 * (2 ** attemptRef.current), 15000);
        attemptRef.current += 1;
        clearTimeout(retryRef.current);
        retryRef.current = setTimeout(connect, delay);
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      activeRef.current = false;
      generation += 1;
      clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [apiBase, currentUser]);

  return { members, connectionStatus, setLocation };
}
