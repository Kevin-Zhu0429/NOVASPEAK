import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_VOLUME,
  LOCAL_AUDIO_PREFS_STORAGE_KEY,
  clampLocalVolume,
  getAudioElementPatch,
  getEffectiveAudioVolume,
  getLocalAudioMemberKey,
  getLocalAudioPreference,
  normalizeLocalAudioPreference,
  readLocalAudioPreferences,
  writeLocalAudioPreference,
} from "./local-audio-preferences.js";

function storage(initial) {
  const data = new Map(initial ? [[LOCAL_AUDIO_PREFS_STORAGE_KEY, initial]] : []);
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test("defaults volume and muted safely", () => {
  assert.equal(normalizeLocalAudioPreference({}).volume, DEFAULT_LOCAL_VOLUME);
  assert.equal(normalizeLocalAudioPreference({}).muted, false);
});

test("clamps invalid and out-of-range volume values", () => {
  assert.equal(clampLocalVolume(-10), 0);
  assert.equal(clampLocalVolume(260), 200);
  assert.equal(clampLocalVolume(Number.NaN), 100);
  assert.equal(normalizeLocalAudioPreference({ volume: "80", muted: "no" }).muted, false);
});

test("broken localStorage JSON falls back without throwing", () => {
  assert.deepEqual(readLocalAudioPreferences(storage("not-json")), {});
});

test("saved preference can be read back", () => {
  const store = storage();
  writeLocalAudioPreference("member-1", { volume: 85, muted: true }, store);
  assert.deepEqual(getLocalAudioPreference("member-1", store), { volume: 85, muted: true });
});

test("member key prefers stable public id and guests fall back to participant identity", () => {
  assert.equal(getLocalAudioMemberKey({ id: "nickname", publicMemberId: "member-key-1" }), "member-key-1");
  assert.equal(getLocalAudioMemberKey({ identity: "guest:uuid:voice:tab" }), "guest:uuid:voice:tab");
});

test("effective volume respects local mute and deafen", () => {
  assert.equal(getEffectiveAudioVolume({ volume: 80 }), 0.8);
  assert.equal(getEffectiveAudioVolume({ volume: 80, muted: true }), 0);
  assert.equal(getEffectiveAudioVolume({ volume: 80, deafened: true }), 0);
});

test("audio element patch clamps browser volume above 100 percent", () => {
  assert.deepEqual(getAudioElementPatch({ volume: 150, muted: false }), { muted: false, volume: 1, requestedVolume: 1.5 });
  assert.deepEqual(getAudioElementPatch({ volume: 50, muted: true }), { muted: true, volume: 0, requestedVolume: 0 });
});
