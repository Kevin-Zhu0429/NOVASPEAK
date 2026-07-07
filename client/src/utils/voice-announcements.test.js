import test from "node:test";
import assert from "node:assert/strict";
import {
  ANNOUNCEMENTS_ENABLED_STORAGE_KEY,
  buildAnnouncementText,
  createAnnouncementSpeaker,
  formatMemberVoiceLabel,
  formatPositionsForSpeech,
  isAnnouncementsEnabled,
  parseAnnouncementMessage,
  setAnnouncementsEnabled,
} from "./voice-announcements.js";

function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

function createFakeSynthesis() {
  return {
    spoken: [],
    cancelCount: 0,
    speak(utterance) { this.spoken.push(utterance); },
    cancel() { this.cancelCount += 1; },
  };
}

function createSpeaker(overrides = {}) {
  const synthesis = createFakeSynthesis();
  const speaker = createAnnouncementSpeaker({
    synthesis,
    createUtterance: (text) => ({ text }),
    ...overrides,
  });
  return { speaker, synthesis };
}

const memberEvent = (patch = {}) => ({
  eventId: patch.eventId || "evt-1",
  eventType: patch.eventType || "server_joined",
  actor: { displayName: "CHILLILY", roleLabel: "管理员", isGuest: false, positionNames: ["队长", "狙击手"], ...(patch.actor || {}) },
  channelName: patch.channelName ?? "CS2",
});

test("五种事件文案正确", () => {
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "server_joined" })), "欢迎 NOVA GAMING 队长、狙击手 CHILLILY 进入服务器");
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "channel_joined", actor: { positionNames: ["狙击手"] } })), "狙击手 CHILLILY 进入频道");
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "channel_left", actor: { positionNames: ["狙击手"] } })), "狙击手 CHILLILY 离开频道");
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "channel_moved" })), "CHILLILY 被移动到 CS2");
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "server_muted" })), "CHILLILY 被闭嘴");
  assert.equal(buildAnnouncementText({ eventType: "unknown_event", actor: {} }), "");
});

test("多职位用顿号连接，访客与无职位有正确称呼", () => {
  assert.equal(formatPositionsForSpeech(["队长", "狙击手"]), "队长、狙击手");
  assert.equal(formatMemberVoiceLabel({ isGuest: true, positionNames: ["队长"] }), "访客");
  assert.equal(formatMemberVoiceLabel({ isGuest: false, positionNames: [], roleLabel: "管理员" }), "管理员");
  assert.equal(formatMemberVoiceLabel({ isGuest: false, positionNames: [] }), "成员");
  assert.equal(buildAnnouncementText(memberEvent({ actor: { isGuest: true, positionNames: [] } })), "欢迎 NOVA GAMING 访客 CHILLILY 进入服务器");
});

test("缺失名称和频道名有兜底", () => {
  assert.equal(buildAnnouncementText(memberEvent({ eventType: "channel_moved", actor: { displayName: "" }, channelName: "" })), "未知成员 被移动到 语音频道");
  assert.equal(buildAnnouncementText({ eventType: "server_muted", actor: {} }), "未知成员 被闭嘴");
});

test("announcement enabled 默认 true", () => {
  assert.equal(isAnnouncementsEnabled(createFakeStorage()), true);
  assert.equal(isAnnouncementsEnabled(createFakeStorage({ [ANNOUNCEMENTS_ENABLED_STORAGE_KEY]: "garbage" })), true);
  const throwing = { getItem: () => { throw new Error("denied"); } };
  assert.equal(isAnnouncementsEnabled(throwing), true);
});

test("localStorage false 后关闭，可重新开启", () => {
  const storage = createFakeStorage();
  setAnnouncementsEnabled(false, storage);
  assert.equal(isAnnouncementsEnabled(storage), false);
  setAnnouncementsEnabled(true, storage);
  assert.equal(isAnnouncementsEnabled(storage), true);
});

test("speechSynthesis 不存在时静默降级不崩溃", () => {
  const speaker = createAnnouncementSpeaker({ synthesis: undefined, createUtterance: () => null });
  assert.equal(speaker.supported, false);
  speaker.setUnlocked(true);
  assert.equal(speaker.enqueue(memberEvent()), false);
  speaker.dispose();
});

test("eventId 去重：同一事件只播一次", () => {
  const { speaker, synthesis } = createSpeaker();
  speaker.setUnlocked(true);
  assert.equal(speaker.enqueue(memberEvent({ eventId: "dup" })), true);
  assert.equal(speaker.enqueue(memberEvent({ eventId: "dup" })), false);
  synthesis.spoken[0].onend();
  assert.equal(synthesis.spoken.length, 1);
});

test("队列按顺序播放，不同时朗读多句", () => {
  const { speaker, synthesis } = createSpeaker();
  speaker.setUnlocked(true);
  speaker.enqueue(memberEvent({ eventId: "e1", eventType: "channel_joined", actor: { positionNames: ["狙击手"] } }));
  speaker.enqueue(memberEvent({ eventId: "e2", eventType: "channel_left", actor: { positionNames: ["狙击手"] } }));
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(synthesis.spoken[0].text, "狙击手 CHILLILY 进入频道");
  assert.equal(synthesis.spoken[0].lang, "zh-CN");
  assert.equal(synthesis.spoken[0].rate, 1);
  synthesis.spoken[0].onend();
  assert.equal(synthesis.spoken.length, 2);
  assert.equal(synthesis.spoken[1].text, "狙击手 CHILLILY 离开频道");
});

test("关闭开关后不播放，事件仍可接收", () => {
  let enabled = false;
  const { speaker, synthesis } = createSpeaker({ isEnabled: () => enabled });
  speaker.setUnlocked(true);
  assert.equal(speaker.enqueue(memberEvent({ eventId: "off-1" })), false);
  assert.equal(synthesis.spoken.length, 0);
  enabled = true;
  assert.equal(speaker.enqueue(memberEvent({ eventId: "on-1" })), true);
  assert.equal(synthesis.spoken.length, 1);
});

test("未解锁（浏览器自动播放限制）前丢弃事件，解锁后新事件正常播放", () => {
  const { speaker, synthesis } = createSpeaker();
  assert.equal(speaker.enqueue(memberEvent({ eventId: "locked-1" })), false);
  speaker.setUnlocked(true);
  assert.equal(speaker.enqueue(memberEvent({ eventId: "after-unlock" })), true);
  assert.equal(synthesis.spoken.length, 1);
});

test("组件卸载时 dispose 清理并 cancel", () => {
  const { speaker, synthesis } = createSpeaker();
  speaker.setUnlocked(true);
  speaker.enqueue(memberEvent({ eventId: "d1" }));
  speaker.dispose();
  assert.equal(synthesis.cancelCount, 1);
  assert.equal(speaker.enqueue(memberEvent({ eventId: "d2" })), false);
});

test("初始 Presence snapshot 与非法消息不触发播报", () => {
  assert.equal(parseAnnouncementMessage(JSON.stringify({ type: "presence:snapshot", members: [] })), null);
  assert.equal(parseAnnouncementMessage("{broken"), null);
  assert.equal(parseAnnouncementMessage(JSON.stringify({ type: "announcement", eventType: "hacked", eventId: "x" })), null);
  assert.equal(parseAnnouncementMessage(JSON.stringify({ type: "announcement", eventType: "server_joined" })), null);
  const parsed = parseAnnouncementMessage(JSON.stringify({ type: "announcement", eventId: "ok", eventType: "server_joined", actor: { displayName: " CHILLILY ", positionNames: ["队长", 7] }, channelName: "CS2" }));
  assert.deepEqual(parsed, { eventId: "ok", eventType: "server_joined", actor: { displayName: "CHILLILY", roleLabel: "", isGuest: false, positionNames: ["队长"] }, channelName: "CS2" });
});
