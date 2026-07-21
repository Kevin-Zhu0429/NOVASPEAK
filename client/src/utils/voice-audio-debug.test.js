import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_AUDIO_SNAPSHOT_FIELDS,
  buildAudioChainSnapshot,
  countMusicBotOutlets,
} from "./voice-audio-debug.js";

test("快照只包含白名单字段，不夹带 entry 上的其他属性", () => {
  const snapshot = buildAudioChainSnapshot({
    attemptId: 3,
    channelId: "channel-1",
    trackSid: "TR_abc",
    entry: {
      participantIdentity: "music-bot:channel-1",
      webAudioEnabled: true,
      // 模拟可能挂在对象上的敏感字段，快照绝不能带出它们
      token: "secret-token",
      cookie: "MUSIC_U=secret",
      playbackUrl: "https://example.com/secret.mp3",
      track: {
        attachedElements: [{}],
        gainNode: { gain: { value: 0.1 } },
        sid: "TR_abc",
      },
      element: { muted: true, volume: 0 },
    },
    audioElementCount: 1,
    room: { audioContext: { state: "running" } },
    now: () => 1234,
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [...VOICE_AUDIO_SNAPSHOT_FIELDS].sort());
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("MUSIC_U"), false);
  assert.equal(serialized.includes("https://"), false);
});

test("快照记录机器人标记、attach 数量、AudioContext 状态与增益值", () => {
  const snapshot = buildAudioChainSnapshot({
    attemptId: 7,
    channelId: "cs2",
    trackSid: "TR_music",
    entry: {
      participantIdentity: "music-bot:cs2",
      webAudioEnabled: true,
      track: { attachedElements: [{}, {}], gainNode: { gain: { value: 0.5 } } },
      element: { muted: false, volume: 1 },
    },
    audioElementCount: 2,
    room: { audioContext: { state: "suspended" } },
    now: () => 99,
  });
  assert.equal(snapshot.isMusicBot, true);
  assert.equal(snapshot.attachedElementCount, 2);
  assert.equal(snapshot.audioElementCount, 2);
  assert.equal(snapshot.audioContextState, "suspended");
  assert.equal(snapshot.elementMuted, false);
  assert.equal(snapshot.elementVolume, 1);
  assert.equal(snapshot.gainValue, 0.5);
  assert.equal(snapshot.timestampMs, 99);
});

test("字段缺失时快照退化为 null / false，不抛错", () => {
  const snapshot = buildAudioChainSnapshot({});
  assert.equal(snapshot.isMusicBot, false);
  assert.equal(snapshot.attachedElementCount, null);
  assert.equal(snapshot.audioElementCount, null);
  assert.equal(snapshot.musicBotOutletCount, null);
  assert.equal(snapshot.audioContextState, null);
  assert.equal(snapshot.elementMuted, null);
  assert.equal(snapshot.elementVolume, null);
  assert.equal(snapshot.gainValue, null);
  assert.equal(buildAudioChainSnapshot().trackSid, "");
});

test("countMusicBotOutlets 统计同一 Room 内机器人音频出口数量", () => {
  assert.equal(countMusicBotOutlets(null), 0);
  assert.equal(countMusicBotOutlets([]), 0);
  assert.equal(
    countMusicBotOutlets([
      { participantIdentity: "music-bot:cs2" },
      { participantIdentity: "42:voice:conn" },
    ]),
    1
  );
  // 同一机器人出现两个出口（重复 publication / 旧音轨未清理）时必须能看出来
  assert.equal(
    countMusicBotOutlets([
      { participantIdentity: "music-bot:cs2" },
      { participantIdentity: "music-bot:cs2" },
    ]),
    2
  );
});
