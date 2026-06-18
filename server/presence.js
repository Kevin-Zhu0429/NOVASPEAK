import { randomUUID } from "node:crypto";
import db from "./db.js";
import { resolveAuthenticatedIdentity } from "./auth-session.js";
import { acceptWebSocket } from "./websocket-connection.js";

export const PRESENCE_PATH = "/ws/presence";
export const PRESENCE_STATES = new Set(["lobby", "in_channel", "reconnecting"]);

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
      for (const connection of principal.connections.keys()) connection.sendJson(snapshot);
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
    connection.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return connection.sendJson({ type: "presence:error", error: "消息不是有效 JSON" }); }
      if (message?.type !== "presence:set-location" || !PRESENCE_STATES.has(message.state)) {
        return connection.sendJson({ type: "presence:error", error: "无效的在线状态消息" });
      }
      const state = principal.connections.get(connection);
      if (!state) return;
      if (message.state === "lobby") {
        state.state = "lobby"; state.channelId = null; state.channelName = "大厅";
      } else {
        if (typeof message.channelId !== "string" || message.channelId.length > 128) {
          return connection.sendJson({ type: "presence:error", error: "无效的频道 ID" });
        }
        const channel = channelLookup(message.channelId);
        if (!channel) return connection.sendJson({ type: "presence:error", error: "频道不存在" });
        state.state = message.state; state.channelId = channel.id; state.channelName = channel.name;
      }
      state.updatedAt = Date.now();
      broadcast();
    });
    connection.on("close", () => removeConnection(key, connection));
    broadcast();
  }

  function handleUpgrade(req, socket, head) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== PRESENCE_PATH) return false;
    let user;
    try { user = authResolver(req); } catch { user = null; }
    if (!user) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n");
      return true;
    }
    const connection = acceptWebSocket(req, socket, head, { maxPayload: 4096 });
    if (connection) addConnection(connection, req, user);
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
        if (!state.alive) connection.terminate();
        else { state.alive = false; connection.ping(); }
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
    close: () => clearInterval(timer),
    broadcast,
  };
}
