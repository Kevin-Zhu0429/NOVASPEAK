import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ConnectionState, DisconnectReason } from "livekit-client";
import { cleanupVoiceRoomAttempt, isVoiceRoomAttemptCurrent, shouldIgnoreConnectErrorForAttempt } from "./voice-room-lifecycle.js";
import { getDisconnectOutcome } from "./voice-room-events.js";

class MockRoom extends EventEmitter {
  constructor(name = "room") {
    super();
    this.name = name;
    this.state = ConnectionState.Connected;
    this.disconnectCalls = 0;
    this.offCalls = 0;
    this.removedAllListeners = false;
  }
  disconnect() { this.disconnectCalls += 1; this.state = ConnectionState.Disconnected; }
  off(eventName, listener) { this.offCalls += 1; return super.off(eventName, listener); }
  removeAllListeners(...args) { this.removedAllListeners = true; return super.removeAllListeners(...args); }
}
function createAttempt(room = new MockRoom()) { return { room, roomRef: { current: room }, connectAttemptRef: { current: 1 }, attemptId: 1 }; }

test("普通 state rerender 不调用 disconnect", () => { const { room } = createAttempt(); assert.equal(room.disconnectCalls, 0); });
test("callback 引用变化不让当前连接尝试失效", () => { const attempt = createAttempt(); assert.notEqual(() => "old", () => "new"); assert.equal(isVoiceRoomAttemptCurrent({ ...attempt, disposed: false }), true); assert.equal(attempt.room.disconnectCalls, 0); });
test("channels 数组引用变化但 channelId 不变时不让当前连接尝试失效", () => { const attempt = createAttempt(); assert.notEqual([{ id: "alpha" }], [{ id: "alpha" }]); assert.equal(isVoiceRoomAttemptCurrent({ ...attempt, disposed: false }), true); assert.equal(attempt.room.disconnectCalls, 0); });
test("channelId 改变时旧 Room 只 disconnect 一次", () => { const attempt = createAttempt(); assert.equal(cleanupVoiceRoomAttempt({ room: attempt.room, roomRef: attempt.roomRef }), true); assert.equal(cleanupVoiceRoomAttempt({ room: attempt.room, roomRef: attempt.roomRef }), false); assert.equal(attempt.room.disconnectCalls, 1); });
test("旧 Room cleanup 不会断开新 Room", () => { const oldRoom = new MockRoom("old"); const newRoom = new MockRoom("new"); const roomRef = { current: newRoom }; assert.equal(cleanupVoiceRoomAttempt({ room: oldRoom, roomRef }), true); assert.equal(oldRoom.disconnectCalls, 1); assert.equal(newRoom.disconnectCalls, 0); assert.equal(roomRef.current, newRoom); });
test("connect 尚未完成时真正切换频道，旧 connect 的取消不显示错误", () => { const attempt = createAttempt(); assert.equal(shouldIgnoreConnectErrorForAttempt({ ...attempt, disposed: true }), true); });
test("CLIENT_INITIATED cleanup 不调用重复 onLeave", () => { assert.deepEqual(getDisconnectOutcome(DisconnectReason.CLIENT_INITIATED), { action: "lobby", message: "", removed: false }); });
test("participant 或 network stats 更新不重连", () => { const attempt = createAttempt(); assert.equal(isVoiceRoomAttemptCurrent({ ...attempt, disposed: false }), true); assert.equal(attempt.room.disconnectCalls, 0); });
test("连接成功后 Room 实例保持稳定", () => { const attempt = createAttempt(); assert.equal(isVoiceRoomAttemptCurrent({ ...attempt, disposed: false }), true); assert.equal(attempt.roomRef.current, attempt.room); });
test("组件真正卸载时正确断开并移除事件监听", () => { const attempt = createAttempt(); const noop = () => {}; attempt.room.on("Disconnected", noop); attempt.room.off("Disconnected", noop); attempt.room.removeAllListeners(); assert.equal(cleanupVoiceRoomAttempt({ room: attempt.room, roomRef: attempt.roomRef }), true); assert.equal(attempt.room.offCalls, 1); assert.equal(attempt.room.removedAllListeners, true); assert.equal(attempt.room.disconnectCalls, 1); assert.equal(attempt.roomRef.current, null); });
