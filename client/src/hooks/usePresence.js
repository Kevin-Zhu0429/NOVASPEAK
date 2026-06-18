import { useCallback, useEffect, useRef, useState } from "react";
import { buildPresenceWebSocketUrl, parsePresenceMessage, sortPresenceMembers } from "../utils/presence-display";

export default function usePresence(currentUser, apiBase = "") {
  const [members, setMembers] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const attemptRef = useRef(0);
  const activeRef = useRef(false);
  const locationRef = useRef({ state: "lobby", channelId: null });

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
      const socket = new WebSocket(buildPresenceWebSocketUrl(apiBase));
      socketRef.current = socket;
      socket.onopen = () => {
        if (ownGeneration !== generation || socketRef.current !== socket) return socket.close();
        attemptRef.current = 0;
        setConnectionStatus("online");
        socket.send(JSON.stringify({ type: "presence:set-location", ...locationRef.current }));
      };
      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        const snapshot = parsePresenceMessage(event.data);
        if (snapshot) setMembers(sortPresenceMembers(snapshot));
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
