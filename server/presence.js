import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import db from "./db.js";
import { resolveAuthenticatedIdentity } from "./auth-session.js";

export const PRESENCE_PATH = "/ws/presence";
export const PRESENCE_STATES = new Set(["lobby", "in_channel", "reconnecting"]);
const MAX_PAYLOAD_BYTES = 4096;
const MAX_BUFFERED_BYTES = 64 * 1024;

export function aggregateConnections(connections) {
  const values = [...connections.values()];
  const active = values.filter((item) => item.state === "in_channel");
  const reconnecting = values.filter((item) => item.state === "reconnecting");
  const preferred = active.length ? active : reconnecting;
  const channelIds = new Set(preferred.map((item) => item.channelId));
  if (channelIds.size > 1) {
    return { state: "multi_channel", channelId: null, channelName: "多个频道" };
  }
  if (preferred.length) {
    return {
      state: active.length ? "in_channel" : "reconnecting",
      channelId: preferred[0].channelId,
      channelName: preferred[0].channelName,
    };
  }
  return { state: "lobby", channelId: null, channelName: "大厅" };
}

export function createPresenceService(options = {}) {
  const principals = new Map();
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const authResolver = options.authResolver ?? resolveAuthenticatedIdentity;
  const channelLookup = options.channelLookup ?? ((id) => db.prepare("SELECT id, name FROM channels WHERE id = ?").get(id));
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  function closeAbnormalConnection(connection) {
    try {
      connection.terminate();
    } catch {
      // The close/error handler performs the shared Presence cleanup.
    }
  }

  function sendJson(connection, value) {
    if (connection.readyState !== WebSocket.OPEN) return false;
    if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
      closeAbnormalConnection(connection);
      return false;
    }
    try {
      connection.send(JSON.stringify(value), (error) => {
        if (error) closeAbnormalConnection(connection);
      });
      return true;
    } catch {
      closeAbnormalConnection(connection);
      return false;
    }
  }

  function principalKey(user) {
    return user.isGuest ? user.id : `user:${user.id}`;
  }

  function profileFor(user) {
    return {
      nickname: user.displayName || user.nickname,
      roleLabel: user.role === "admin" ? "管理员" : user.isGuest ? "访客" : "成员",
      isGuest: Boolean(user.isGuest),
      positions: user.positions || [],
      positionNames: user.positionNames || [],
    };
  }

  function publicMembers(viewerKey) {
    return [...principals.entries()].map(([key, principal]) => ({
      presenceId: principal.publicPresenceId,
      ...principal.profile,
      ...aggregateConnections(principal.connections),
      deviceCount: principal.connections.size,
      isCurrentUser: key === viewerKey,
    }));
  }

  function broadcast() {
    for (const [viewerKey, principal] of principals) {
      const snapshot = { type: "presence:snapshot", members: publicMembers(viewerKey) };
      for (const connection of principal.connections.keys()) sendJson(connection, snapshot);
    }
  }

  function removeConnection(key, connection) {
    const principal = principals.get(key);
    if (!principal || !principal.connections.delete(connection)) return;
    if (!principal.connections.size) principals.delete(key);
    broadcast();
  }

  function addConnection(connection, req, user) {
    const key = principalKey(user);
    let principal = principals.get(key);
    if (!principal) {
      principal = {
        publicPresenceId: randomUUID(),
        profile: profileFor(user),
        connections: new Map(),
      };
      principals.set(key, principal);
    } else {
      principal.profile = profileFor(user);
    }
    principal.connections.set(connection, {
      state: "lobby", channelId: null, channelName: "大厅",
      connectedAt: Date.now(), updatedAt: Date.now(), alive: true, req,
    });
    connection.on("pong", () => {
      const state = principal?.connections.get(connection);
      if (state) state.alive = true;
    });
    connection.on("message", (data, isBinary) => {
      if (isBinary) {
        connection.close(1003, "仅支持文本消息");
        return;
      }
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
        connection.close(1009, "消息过大");
        return;
      }
      let message;
      try { message = JSON.parse(raw); } catch { return sendJson(connection, { type: "presence:error", error: "消息不是有效 JSON" }); }
      if (message?.type !== "presence:set-location" || !PRESENCE_STATES.has(message.state)) {
        return sendJson(connection, { type: "presence:error", error: "无效的在线状态消息" });
      }
      const state = principal.connections.get(connection);
      if (!state) return;
      if (message.state === "lobby") {
        state.state = "lobby"; state.channelId = null; state.channelName = "大厅";
      } else {
        if (typeof message.channelId !== "string" || message.channelId.length > 128) {
          return sendJson(connection, { type: "presence:error", error: "无效的频道 ID" });
        }
        const channel = channelLookup(message.channelId);
        if (!channel) return sendJson(connection, { type: "presence:error", error: "频道不存在" });
        state.state = message.state; state.channelId = channel.id; state.channelName = channel.name;
      }
      state.updatedAt = Date.now();
      broadcast();
    });
    connection.on("close", () => removeConnection(key, connection));
    connection.on("error", () => removeConnection(key, connection));
    broadcast();
  }

  function handleUpgrade(req, socket, head) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== PRESENCE_PATH) return false;
    let user;
    try {
      user = authResolver(req);
    } catch (error) {
      console.error("Presence WebSocket authentication failed:", error?.message || "unknown error");
      user = null;
    }
    if (!user) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n");
      return true;
    }
    try {
      wss.handleUpgrade(req, socket, head, (connection) => {
        addConnection(connection, req, user);
      });
    } catch (error) {
      console.error("Presence WebSocket upgrade failed:", error?.message || "unknown error");
      if (!socket.destroyed) socket.destroy();
    }
    return true;
  }

  const timer = setInterval(() => {
    let changed = false;
    for (const [key, principal] of principals) {
      for (const [connection, state] of principal.connections) {
        let user;
        try { user = authResolver(state.req); } catch { user = null; }
        if (!user || principalKey(user) !== key) {
          connection.close(4401, "登录状态已失效");
          continue;
        }
        const nextProfile = profileFor(user);
        if (JSON.stringify(nextProfile) !== JSON.stringify(principal.profile)) {
          principal.profile = nextProfile; changed = true;
        }
        if (!state.alive) {
          closeAbnormalConnection(connection);
        } else {
          state.alive = false;
          try {
            connection.ping();
          } catch {
            closeAbnormalConnection(connection);
          }
        }
      }
    }
    if (changed) broadcast();
  }, heartbeatMs);
  timer.unref?.();

  return {
    handleUpgrade,
    publicMembers,
    principals,
    addConnection,
    close: () => {
      clearInterval(timer);
      for (const principal of principals.values()) {
        for (const connection of principal.connections.keys()) {
          closeAbnormalConnection(connection);
        }
      }
      wss.close();
    },
    broadcast,
  };
}
