import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_AUDIO_PREFS_STORAGE_KEY,
  MUSIC_BOT_AUDIO_KEY,
  applyRemoteAudioPlaybackPreference,
  applyRemoteParticipantVolumePreference,
  clampMemberVolume,
  disableRemoteTrackWebAudio,
  getAudioElementPatch,
  getDefaultMemberVolume,
  getEffectiveVolume,
  getMemberAudioKey,
  getMemberAudioPref,
  getRemoteAudioPlaybackPlan,
  loadLocalAudioPrefs,
  normalizeMemberAudioPref,
  prepareRemoteAudioElement,
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

test("音乐机器人未设置本地偏好时默认音量为 10%，显式设置仍被保留", () => {
  assert.equal(getDefaultMemberVolume("music-bot:cs2"), 10);
  assert.equal(getMemberAudioPref({}, "music-bot:cs2").volume, 10);
  assert.equal(getMemberAudioPref({ "music-bot:cs2": { volume: 80 } }, "music-bot:cs2").volume, 80);
  assert.equal(getMemberAudioPref({}, "ordinary-member").volume, 100);
});

test("所有频道的音乐机器人共用同一个本地音量键", () => {
  assert.equal(getMemberAudioKey("music-bot:channel-a"), MUSIC_BOT_AUDIO_KEY);
  assert.equal(getMemberAudioKey("music-bot:channel-b"), MUSIC_BOT_AUDIO_KEY);

  const first = setMemberAudioPref({}, "music-bot:channel-a", { volume: 2 });
  const second = setMemberAudioPref(first, "music-bot:channel-b", { muted: true });
  assert.deepEqual(second, {
    [MUSIC_BOT_AUDIO_KEY]: { volume: 2, muted: true },
  });
  assert.deepEqual(getMemberAudioPref(second, "music-bot:channel-c"), { volume: 2, muted: true });
});

test("旧版分频道机器人偏好迁移时保留更安静的设置", () => {
  const storage = createFakeStorage({
    [LOCAL_AUDIO_PREFS_STORAGE_KEY]: JSON.stringify({
      "music-bot:channel-a": { volume: 10, muted: false },
      "music-bot:channel-b": { volume: 2, muted: true },
      "member-1": { volume: 75, muted: false },
    }),
  });
  assert.deepEqual(loadLocalAudioPrefs(storage), {
    [MUSIC_BOT_AUDIO_KEY]: { volume: 2, muted: true },
    "member-1": { volume: 75, muted: false },
  });
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

test("Web Audio 模式下 200% 音量由 GainNode 真实放大两倍", () => {
  assert.deepEqual(
    getRemoteAudioPlaybackPlan({ volume: 200, webAudioEnabled: true }),
    { elementMuted: true, elementVolume: 1, trackVolume: 2 }
  );
});

test("远端 audio 元素在 attach 前先静音，阻止默认 100% 抢先播放", () => {
  const element = { autoplay: false, controls: true, muted: false, volume: 1 };
  assert.equal(prepareRemoteAudioElement(element), true);
  assert.deepEqual(element, {
    autoplay: true,
    controls: false,
    muted: true,
    volume: 0,
  });
});

test("音乐机器人可断开 Web Audio 节点并使用原生元素", () => {
  const contexts = [];
  assert.equal(disableRemoteTrackWebAudio({
    setAudioContext: (context) => contexts.push(context),
  }), true);
  assert.deepEqual(contexts, [undefined]);
  assert.equal(disableRemoteTrackWebAudio({}), false);
});

test("Web Audio 模式下本地静音与 Deafen 都把轨道增益设为 0", () => {
  assert.equal(
    getRemoteAudioPlaybackPlan({ volume: 180, localMuted: true, webAudioEnabled: true }).trackVolume,
    0
  );
  assert.equal(
    getRemoteAudioPlaybackPlan({ volume: 180, deafened: true, webAudioEnabled: true }).trackVolume,
    0
  );
});

test("不支持 Web Audio 时仍安全降级到 audio 元素 100% 上限", () => {
  assert.deepEqual(
    getRemoteAudioPlaybackPlan({ volume: 200, webAudioEnabled: false }),
    { elementMuted: false, elementVolume: 1, trackVolume: null }
  );
});

test("音乐机器人音轨重新创建后会再次应用保存的 10% 增益", () => {
  const firstVolumes = [];
  const secondVolumes = [];
  const firstElement = {};
  const secondElement = {};

  const first = applyRemoteAudioPlaybackPreference({
    track: { setVolume: (value) => firstVolumes.push(value) },
    element: firstElement,
    volume: 10,
    webAudioEnabled: true,
  });
  const second = applyRemoteAudioPlaybackPreference({
    track: { setVolume: (value) => secondVolumes.push(value) },
    element: secondElement,
    volume: 10,
    webAudioEnabled: true,
  });

  assert.deepEqual(firstVolumes, [0.1]);
  assert.deepEqual(secondVolumes, [0.1]);
  assert.deepEqual(first, {
    webAudioEnabled: true,
    plan: { elementMuted: true, elementVolume: 0.1, trackVolume: 0.1 },
  });
  assert.deepEqual(second, first);
  assert.deepEqual(firstElement, { muted: true, volume: 0.1 });
  assert.deepEqual(secondElement, { muted: true, volume: 0.1 });
});

test("音乐机器人在音轨挂载前把 2% 音量写入 participant 的 source 映射", () => {
  const calls = [];
  const participant = {
    setVolume: (volume, source) => calls.push({ volume, source }),
  };

  const applied = applyRemoteParticipantVolumePreference({
    participant,
    source: "microphone",
    volume: 2,
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [{ volume: 0.02, source: "microphone" }]);
});

test("participant 音量映射与当前 track 会同时获得 2% 增益", () => {
  const participantVolumes = [];
  const trackVolumes = [];
  const element = {};

  const result = applyRemoteAudioPlaybackPreference({
    participant: { setVolume: (volume, source) => participantVolumes.push({ volume, source }) },
    source: "microphone",
    track: { setVolume: (volume) => trackVolumes.push(volume) },
    element,
    volume: 2,
    webAudioEnabled: true,
  });

  assert.deepEqual(participantVolumes, [{ volume: 0.02, source: "microphone" }]);
  assert.deepEqual(trackVolumes, [0.02]);
  assert.deepEqual(result, {
    webAudioEnabled: true,
    plan: { elementMuted: true, elementVolume: 0.02, trackVolume: 0.02 },
  });
  assert.deepEqual(element, { muted: true, volume: 0.02 });
});

test("音乐机器人优先原生播放时禁用 GainNode 并直接应用 2% 元素音量", () => {
  const contexts = [];
  const trackVolumes = [];
  const element = {};
  const result = applyRemoteAudioPlaybackPreference({
    track: {
      setAudioContext: (context) => contexts.push(context),
      setVolume: (volume) => trackVolumes.push(volume),
    },
    element,
    volume: 2,
    webAudioEnabled: true,
    preferNativePlayback: true,
  });

  assert.deepEqual(contexts, [undefined]);
  assert.deepEqual(trackVolumes, []);
  assert.deepEqual(result, {
    webAudioEnabled: false,
    plan: { elementMuted: false, elementVolume: 0.02, trackVolume: null },
  });
  assert.deepEqual(element, { muted: false, volume: 0.02 });
});

test("participant 音量映射失败时仍回退到当前 track", () => {
  const trackVolumes = [];
  const result = applyRemoteAudioPlaybackPreference({
    participant: { setVolume: () => { throw new Error("participant not ready"); } },
    source: "microphone",
    track: { setVolume: (volume) => trackVolumes.push(volume) },
    element: {},
    volume: 2,
    webAudioEnabled: true,
  });

  assert.deepEqual(trackVolumes, [0.02]);
  assert.equal(result.webAudioEnabled, true);
});

test("音轨增益暂不可用时回退 audio 元素并保持相同偏好", () => {
  const element = {};
  const result = applyRemoteAudioPlaybackPreference({
    track: { setVolume: () => { throw new Error("audio context not ready"); } },
    element,
    volume: 10,
    webAudioEnabled: true,
  });

  assert.equal(result.webAudioEnabled, false);
  assert.deepEqual(result.plan, { elementMuted: false, elementVolume: 0.1, trackVolume: null });
  assert.deepEqual(element, { muted: false, volume: 0.1 });
});
