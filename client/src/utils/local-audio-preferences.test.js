import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_AUDIO_PREFS_STORAGE_KEY,
  clampMemberVolume,
  getAudioElementPatch,
  getEffectiveVolume,
  getMemberAudioKey,
  getMemberAudioPref,
  loadLocalAudioPrefs,
  normalizeMemberAudioPref,
  saveLocalAudioPrefs,
  setMemberAudioPref,
} from "./local-audio-preferences.js";

function createFakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
}

test("默认音量为 100", () => {
  assert.equal(getMemberAudioPref({}, "member-1").volume, 100);
  assert.equal(normalizeMemberAudioPref(null).volume, 100);
});

test("默认本地静音为 false", () => {
  assert.equal(getMemberAudioPref({}, "member-1").muted, false);
  assert.equal(normalizeMemberAudioPref(undefined).muted, false);
});

test("音量小于 0 时 clamp 到 0", () => {
  assert.equal(clampMemberVolume(-30), 0);
  assert.equal(normalizeMemberAudioPref({ volume: -5 }).volume, 0);
});

test("音量大于上限时 clamp 到 200", () => {
  assert.equal(clampMemberVolume(999), 200);
  assert.equal(normalizeMemberAudioPref({ volume: 500 }).volume, 200);
});

test("非数字音量回退默认值 100", () => {
  assert.equal(clampMemberVolume("abc"), 100);
  assert.equal(clampMemberVolume(NaN), 100);
  assert.equal(clampMemberVolume(true), 100);
  assert.equal(normalizeMemberAudioPref({ volume: "loud" }).volume, 100);
});

test("muted 非 boolean 时回退 false", () => {
  assert.equal(normalizeMemberAudioPref({ muted: "yes" }).muted, false);
  assert.equal(normalizeMemberAudioPref({ muted: 1 }).muted, false);
  assert.equal(normalizeMemberAudioPref({ muted: true }).muted, true);
});

test("localStorage JSON 损坏时不崩溃并回退空对象", () => {
  const storage = createFakeStorage({ [LOCAL_AUDIO_PREFS_STORAGE_KEY]: "{broken json" });
  assert.deepEqual(loadLocalAudioPrefs(storage), {});
  const arrayStorage = createFakeStorage({ [LOCAL_AUDIO_PREFS_STORAGE_KEY]: "[1,2]" });
  assert.deepEqual(loadLocalAudioPrefs(arrayStorage), {});
});

test("storage 访问抛错时安全回退", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  assert.deepEqual(loadLocalAudioPrefs(throwing), {});
  assert.equal(saveLocalAudioPrefs({ a: { volume: 50, muted: true } }, throwing), false);
});

test("保存后可读取，且写入值已 clamp / 归一化", () => {
  const storage = createFakeStorage();
  const prefs = setMemberAudioPref({}, "member-1", { volume: 350, muted: "yes" });
  assert.equal(saveLocalAudioPrefs(prefs, storage), true);
  const loaded = loadLocalAudioPrefs(storage);
  assert.deepEqual(loaded["member-1"], { volume: 200, muted: false });
});

test("setMemberAudioPref 不修改原对象且保留其他成员", () => {
  const before = { "member-1": { volume: 60, muted: false } };
  const after = setMemberAudioPref(before, "member-2", { muted: true });
  assert.deepEqual(before, { "member-1": { volume: 60, muted: false } });
  assert.deepEqual(after["member-1"], { volume: 60, muted: false });
  assert.deepEqual(after["member-2"], { volume: 100, muted: true });
});

test("member key 优先使用稳定成员 ID，不使用昵称", () => {
  assert.equal(getMemberAudioKey({ id: "42:voice:conn-abc123", displayName: "昵称ABC" }), "42");
  assert.equal(getMemberAudioKey("member-7:voice:xyz-000111"), "member-7");
});

test("guest 使用 guest identity / participant identity 兜底", () => {
  assert.equal(getMemberAudioKey({ id: "guest:uuid-1234:voice:conn-1" }), "guest:uuid-1234");
  assert.equal(getMemberAudioKey({ id: "guest:uuid-5678" }), "guest:uuid-5678");
  assert.equal(getMemberAudioKey({ id: "" }), "");
  assert.equal(getMemberAudioKey(null), "");
});

test("未静音时有效音量等于 volume / 100", () => {
  assert.equal(getEffectiveVolume({ deafened: false, localMuted: false, volume: 85 }), 0.85);
  assert.equal(getEffectiveVolume({ volume: 50 }), 0.5);
});

test("本地静音时有效音量为 0", () => {
  assert.equal(getEffectiveVolume({ deafened: false, localMuted: true, volume: 150 }), 0);
});

test("Deafen 时有效音量为 0", () => {
  assert.equal(getEffectiveVolume({ deafened: true, localMuted: false, volume: 100 }), 0);
});

test("超过 100% 时 audio 元素 volume clamp 到 1", () => {
  assert.equal(getEffectiveVolume({ volume: 200 }), 2);
  assert.equal(getAudioElementPatch({ deafened: false, localMuted: false, volume: 200 }).volume, 1);
  assert.equal(getAudioElementPatch({ volume: 150 }).volume, 1);
});

test("设置变化后生成正确 audio patch", () => {
  assert.deepEqual(getAudioElementPatch({ deafened: false, localMuted: false, volume: 60 }), { muted: false, volume: 0.6 });
  assert.deepEqual(getAudioElementPatch({ deafened: false, localMuted: true, volume: 60 }), { muted: false, volume: 0 });
  assert.deepEqual(getAudioElementPatch({ deafened: true, localMuted: false, volume: 60 }), { muted: true, volume: 0.6 });
  assert.deepEqual(getAudioElementPatch({ deafened: true, localMuted: true, volume: 60 }), { muted: true, volume: 0 });
});
