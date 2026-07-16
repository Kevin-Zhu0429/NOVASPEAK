import test from "node:test";
import assert from "node:assert/strict";
import { createMusicBotAudioSession, getMusicBotIdentity } from "./livekit-bot.js";

test("music bot audio session uses stable identity and captures 480 sample frames", async () => {
  const calls = [];
  const rtc = {
    Room: class { constructor() { this.localParticipant = { publishTrack: async () => ({ sid: "pub" }), unpublishTrack: async () => calls.push("unpublish") }; } async connect(url, token, opts) { calls.push([url, token, opts]); } async disconnect() { calls.push("disconnect"); } },
    AudioSource: class { constructor(rate, channels, queue) { calls.push([rate, channels, queue]); } async captureFrame(frame) { calls.push(frame.samplesPerChannel); } async waitForPlayout() { calls.push("wait"); } async close() { calls.push("source-close"); } },
    AudioFrame: class { constructor(samples, rate, channels, samplesPerChannel) { this.samplesPerChannel = samplesPerChannel; } },
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class { constructor(options) { this.options = options; } },
    TrackSource: { SOURCE_MICROPHONE: "mic" },
  };
  const session = createMusicBotAudioSession({ channelId: "cs2", env: { LIVEKIT_URL: "ws://lk", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" }, token: "token", loadRtc: async () => rtc });
  assert.equal(session.identity, getMusicBotIdentity("cs2"));
  await session.connect();
  await session.capturePcmFrame(new Int16Array(480));
  await session.waitForPlayout();
  await session.close();
  await session.close();
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 48000 && c[1] === 1));
  assert.ok(calls.includes(480));
  assert.ok(calls.includes("wait"));
  assert.ok(calls.includes("disconnect"));
});
