import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESENCE_CONNECTED_MARKER_KEY,
  buildPresenceWebSocketUrl, clearPresenceConnectedMarker,
  getPresenceDeviceText, getPresenceLocationText, getPresencePositionText,
  markPresenceConnected, parsePresenceMessage,
  shouldClaimFreshPresenceLogin, sortPresenceMembers,
} from "./presence-display.js";

test("parses valid snapshots and rejects malformed messages", () => {
  const member = { presenceId: "p", nickname: "Nova", state: "lobby" };
  assert.deepEqual(parsePresenceMessage(JSON.stringify({ type: "presence:snapshot", members: [member] })), [member]);
  assert.equal(parsePresenceMessage("{bad"), null);
});

test("sort is current user then channel, reconnecting and lobby", () => {
  const members = [
    { presenceId: "1", nickname: "B", state: "lobby" },
    { presenceId: "2", nickname: "A", state: "reconnecting" },
    { presenceId: "3", nickname: "C", state: "in_channel" },
    { presenceId: "4", nickname: "Me", state: "lobby", isCurrentUser: true },
  ];
  assert.deepEqual(sortPresenceMembers(members).map((item) => item.presenceId), ["4", "3", "2", "1"]);
});

test("formats location, positions, guest and devices", () => {
  assert.equal(getPresenceLocationText({ state: "reconnecting", channelName: "CS2" }), "正在重连 · CS2");
  assert.equal(getPresencePositionText({ positionNames: ["队长", "狙击手"] }), "队长 · 狙击手");
  assert.equal(getPresencePositionText({ isGuest: true }), "访客");
  assert.equal(getPresenceDeviceText({ deviceCount: 2 }), "2 个设备在线");
});

test("presence WebSocket URL 支持 fresh=1 声明，默认不带查询参数", () => {
  const location = { href: "https://voice.novagaming.top/app?x=1#hash" };
  assert.equal(buildPresenceWebSocketUrl("", location), "wss://voice.novagaming.top/ws/presence");
  assert.equal(buildPresenceWebSocketUrl("", location, { freshLogin: true }), "wss://voice.novagaming.top/ws/presence?fresh=1");
  assert.equal(buildPresenceWebSocketUrl("http://localhost:3001", location, { freshLogin: true }), "ws://localhost:3001/ws/presence?fresh=1");
});

function createFakeSessionStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

test("fresh 登录标记：首次连接前声明 fresh，连接后不再声明，登出清除后恢复", () => {
  const storage = createFakeSessionStorage();
  assert.equal(shouldClaimFreshPresenceLogin(storage), true);
  markPresenceConnected(storage);
  assert.equal(storage.data.get(PRESENCE_CONNECTED_MARKER_KEY), "1");
  assert.equal(shouldClaimFreshPresenceLogin(storage), false);
  clearPresenceConnectedMarker(storage);
  assert.equal(shouldClaimFreshPresenceLogin(storage), true);
  // sessionStorage 缺失或异常时不声明 fresh（保守：宁可少播欢迎也不制造重连风暴）
  const throwing = { getItem: () => { throw new Error("denied"); } };
  assert.equal(shouldClaimFreshPresenceLogin(throwing), false);
  assert.equal(shouldClaimFreshPresenceLogin(null), false);
  assert.doesNotThrow(() => markPresenceConnected(null));
  assert.doesNotThrow(() => clearPresenceConnectedMarker(null));
});
