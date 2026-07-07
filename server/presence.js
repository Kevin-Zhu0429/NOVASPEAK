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

const LOBBY_LOCATION = Object.freeze({ state: "lobby", channelId: null, channelName: "大厅" });

export const ANNOUNCEMENT_EVENT_TYPES = Object.freeze([
  "server_joined",
  "channel_joined",
  "channel_left",
  "channel_moved",
  "server_muted",
]);

export function createPresenceService(options = {}) {
  const principals = new Map();
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const autoHeartbeat = options.autoHeartbeat ?? true;
  const diagnosticLogger = options.diagnosticLogger;
  const authResolver = options.authResolver ?? resolveAuthenticatedIdentity;
  const channelLookup = options.channelLookup ?? ((id) => db.prepare("SELECT id, name FROM channels WHERE id = ?").get(id));
  // 语音播报事件：降级（离开频道/离线）延迟 graceMs 播报，刷新或短暂重连在窗口内恢复则静默；
  // 服务重启后的 startupQuietMs 内不播欢迎，避免全员重连造成欢迎风暴。
  const announcementGraceMs = options.announcementGraceMs ?? 10_000;
  const startupQuietMs = options.startupQuietMs ?? 15_000;
  const announcementIdFactory = options.announcementIdFactory ?? randomUUID;
  const startedAt = Date.now();
  const pendingOffline = new Map();
  const recentMoves = new Map();
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


  function findChannelConnection(identity, sourceChannelId) {
    for (const [key, principal] of principals) {
      for (const [connection, state] of principal.connections) {
        const userId = state.req?.authUserId;
        if (userId === identity && state.channelId === sourceChannelId) return { connection, state, key, principal };
      }
    }
    return null;
  }

  function announcementActor(profile = {}) {
    return {
      displayName: typeof profile.nickname === "string" && profile.nickname.trim() ? profile.nickname.trim() : "未知成员",
      roleLabel: typeof profile.roleLabel === "string" ? profile.roleLabel : "",
      isGuest: profile.isGuest === true,
      positionNames: Array.isArray(profile.positionNames) ? profile.positionNames.filter((name) => typeof name === "string" && name) : [],
    };
  }

  // 播报范围：当前实现广播给全部在线连接；如需按频道筛选，可在此按
  // principal 的 aggregateConnections 位置过滤（预留扩展点）。
  function broadcastAnnouncement({ eventType, actor, channelId = null, channelName = "" } = {}) {
    if (!ANNOUNCEMENT_EVENT_TYPES.includes(eventType)) return null;
    const payload = {
      type: "announcement",
      eventId: announcementIdFactory(),
      eventType,
      createdAt: Date.now(),
      actor: announcementActor(actor ? { nickname: actor.displayName, ...actor } : {}),
      channelId: typeof channelId === "string" ? channelId : null,
      channelName: typeof channelName === "string" ? channelName : "",
    };
    for (const principal of principals.values()) {
      for (const connection of principal.connections.keys()) sendJson(connection, payload);
    }
    return payload;
  }

  // LiveKit participantIdentity 形如 "<用户ID>:voice:<连接ID>"，归一化为 principal key。
  function principalKeyForParticipantIdentity(participantIdentity) {
    const identity = typeof participantIdentity === "string" ? participantIdentity.trim() : "";
    if (!identity) return "";
    const marker = identity.indexOf(":voice:");
    const baseId = marker > 0 ? identity.slice(0, marker) : identity;
    return baseId.startsWith("guest:") ? baseId : `user:${baseId}`;
  }

  // 移动成员成功后调用：随后到达目标频道的位置变化不再播进入/离开（由 channel_moved 覆盖）。
  function noteParticipantMoved(participantIdentity, targetChannelId) {
    const key = principalKeyForParticipantIdentity(participantIdentity);
    if (!key || typeof targetChannelId !== "string" || !targetChannelId) return false;
    recentMoves.set(key, { channelId: targetChannelId, at: Date.now() });
    return true;
  }

  function consumeRecentMove(key, channelId) {
    const entry = recentMoves.get(key);
    if (!entry) return false;
    if (Date.now() - entry.at > announcementGraceMs) {
      recentMoves.delete(key);
      return false;
    }
    if (entry.channelId !== channelId) return false;
    recentMoves.delete(key);
    return true;
  }

  function scheduleDowngrade(key, principal) {
    if (principal.downgradeTimer) return;
    principal.downgradeTimer = setTimeout(() => fireDowngrade(key), announcementGraceMs);
    principal.downgradeTimer.unref?.();
  }

  function fireDowngrade(key) {
    const principal = principals.get(key);
    if (!principal) return;
    principal.downgradeTimer = null;
    const aggregate = aggregateConnections(principal.connections);
    if (aggregate.state === "in_channel") return;
    if (aggregate.state === "reconnecting" || aggregate.state === "multi_channel") {
      scheduleDowngrade(key, principal);
      return;
    }
    const announced = principal.announcedLocation;
    principal.announcedLocation = LOBBY_LOCATION;
    if (announced.state === "in_channel") {
      broadcastAnnouncement({ eventType: "channel_left", actor: announcementActor(principal.profile), channelId: announced.channelId, channelName: announced.channelName });
    }
  }

  function fireOffline(key) {
    const entry = pendingOffline.get(key);
    if (!entry) return;
    pendingOffline.delete(key);
    if (entry.announcedLocation.state === "in_channel") {
      broadcastAnnouncement({ eventType: "channel_left", actor: announcementActor(entry.profile), channelId: entry.announcedLocation.channelId, channelName: entry.announcedLocation.channelName });
    }
  }

  // announcedLocation 是“听众已知”的稳定位置：进入频道立即播报，
  // 离开走降级定时器（graceMs 内恢复则静默），reconnecting/multi_channel 不改变它。
  function evaluateAnnouncedLocation(key, principal) {
    const aggregate = aggregateConnections(principal.connections);
    if (aggregate.state === "in_channel") {
      const announced = principal.announcedLocation;
      if (announced.state === "in_channel" && announced.channelId === aggregate.channelId) {
        if (principal.downgradeTimer) {
          clearTimeout(principal.downgradeTimer);
          principal.downgradeTimer = null;
        }
        return;
      }
      if (principal.downgradeTimer) {
        clearTimeout(principal.downgradeTimer);
        principal.downgradeTimer = null;
      }
      principal.announcedLocation = { state: "in_channel", channelId: aggregate.channelId, channelName: aggregate.channelName };
      if (consumeRecentMove(key, aggregate.channelId)) return;
      const actor = announcementActor(principal.profile);
      if (announced.state === "in_channel") {
        broadcastAnnouncement({ eventType: "channel_left", actor, channelId: announced.channelId, channelName: announced.channelName });
      }
      broadcastAnnouncement({ eventType: "channel_joined", actor, channelId: aggregate.channelId, channelName: aggregate.channelName });
      return;
    }
    if (aggregate.state !== "lobby") return;
    if (principal.announcedLocation.state !== "in_channel") return;
    scheduleDowngrade(key, principal);
  }

  function announceServerJoined(principal) {
    if (Date.now() - startedAt < startupQuietMs) return;
    broadcastAnnouncement({ eventType: "server_joined", actor: announcementActor(principal.profile) });
  }

  function sendCommandToChannelConnection(identity, sourceChannelId, command) {
    const match = findChannelConnection(identity, sourceChannelId);
    if (!match) return false;
    return sendJson(match.connection, command);
  }

  function setConnectionLocation(identity, sourceChannelId, nextState) {
    const match = findChannelConnection(identity, sourceChannelId);
    if (!match) return false;
    match.state.state = nextState.state;
    match.state.channelId = nextState.channelId;
    match.state.channelName = nextState.channelName;
    match.state.updatedAt = Date.now();
    evaluateAnnouncedLocation(match.key, match.principal);
    broadcast();
    return true;
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
    if (!principal.connections.size) {
      principals.delete(key);
      if (principal.downgradeTimer) {
        clearTimeout(principal.downgradeTimer);
        principal.downgradeTimer = null;
      }
      const previous = pendingOffline.get(key);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => fireOffline(key), announcementGraceMs);
      timer.unref?.();
      pendingOffline.set(key, { announcedLocation: principal.announcedLocation, profile: principal.profile, timer });
    } else {
      evaluateAnnouncedLocation(key, principal);
    }
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
        announcedLocation: LOBBY_LOCATION,
        downgradeTimer: null,
      };
      principals.set(key, principal);
      const offline = pendingOffline.get(key);
      if (offline) {
        // graceMs 内重连（刷新/网络抖动）：恢复已播报位置，不再播欢迎
        clearTimeout(offline.timer);
        pendingOffline.delete(key);
        principal.announcedLocation = offline.announcedLocation;
      } else {
        // 从 0 连接变为 1 连接才算真正进入服务器；此时新连接尚未注册，
        // 欢迎语只发给其他在线成员，自己不播自己的登录
        announceServerJoined(principal);
      }
    } else {
      principal.profile = profileFor(user);
    }
    req.authUserId = user.id;
    principal.connections.set(connection, {
      state: "lobby", channelId: null, channelName: "大厅",
      connectedAt: Date.now(), updatedAt: Date.now(), req,
    });
    connection.isAlive = true;
    connection.on("pong", () => {
      connection.isAlive = true;
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
      evaluateAnnouncedLocation(key, principal);
      broadcast();
    });
    connection.on("close", () => removeConnection(key, connection));
    connection.on("error", () => removeConnection(key, connection));
    evaluateAnnouncedLocation(key, principal);
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

  function safeDiagnostic(event) {
    if (typeof diagnosticLogger !== "function") return;
    try { diagnosticLogger(event); } catch { /* diagnostics must never affect Presence */ }
  }

  async function runTransportHeartbeatCheck() {
    for (const principal of principals.values()) {
      for (const connection of principal.connections.keys()) {
        safeDiagnostic({ phase: "transport", isAlive: connection.isAlive });
        if (connection.isAlive === false) {
          safeDiagnostic({ phase: "transport", isAlive: connection.isAlive, terminateRequested: true });
          closeAbnormalConnection(connection);
          continue;
        }

        connection.isAlive = false;
        try {
          connection.ping();
        } catch {
          safeDiagnostic({ phase: "transport", isAlive: connection.isAlive, terminateRequested: true });
          closeAbnormalConnection(connection);
        }
      }
    }
  }

  async function runIdentityRevalidation() {
    let changed = false;
    const revalidationTasks = [];

    for (const [key, principal] of principals) {
      for (const [connection, state] of principal.connections) {
        revalidationTasks.push((async () => {
          let user;
          try { user = await authResolver(state.req); } catch { user = null; }
          const valid = Boolean(user && principalKey(user) === key);
          safeDiagnostic({ phase: "identity", isAlive: connection.isAlive, identity: valid ? "valid" : "invalid" });
          if (!valid) {
            safeDiagnostic({ phase: "identity", isAlive: connection.isAlive, identity: "invalid", closeRequested: true });
            connection.close(4401, "登录状态已失效");
            return;
          }
          const nextProfile = profileFor(user);
          if (JSON.stringify(nextProfile) !== JSON.stringify(principal.profile)) {
            principal.profile = nextProfile; changed = true;
          }
        })());
      }
    }

    await Promise.allSettled(revalidationTasks);
    if (changed) broadcast();
  }

  async function runHeartbeatCheck() {
    await runTransportHeartbeatCheck();
    await runIdentityRevalidation();
  }

  let heartbeatRunning = false;
  const timer = autoHeartbeat ? setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    Promise.resolve(runHeartbeatCheck())
      .catch((error) => {
        console.error("Presence heartbeat failed:", error?.message || "unknown error");
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, heartbeatMs) : null;
  timer?.unref?.();

  return {
    handleUpgrade,
    publicMembers,
    principals,
    runHeartbeatCheck,
    runTransportHeartbeatCheck,
    runIdentityRevalidation,
    sendCommandToChannelConnection,
    setConnectionLocation,
    broadcastAnnouncement,
    noteParticipantMoved,
    addConnection,
    close: () => {
      if (timer) clearInterval(timer);
      for (const principal of principals.values()) {
        if (principal.downgradeTimer) clearTimeout(principal.downgradeTimer);
        principal.downgradeTimer = null;
        for (const connection of principal.connections.keys()) {
          closeAbnormalConnection(connection);
        }
      }
      for (const entry of pendingOffline.values()) clearTimeout(entry.timer);
      pendingOffline.clear();
      recentMoves.clear();
      wss.close();
    },
    broadcast,
  };
}
