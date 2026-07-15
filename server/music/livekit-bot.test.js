import test from "node:test";
import assert from "node:assert/strict";
import {
  MUSIC_BOT_ERROR,
  MUSIC_BOT_NAME,
  buildMusicBotToken,
  getMusicBotIdentity,
  playTestToneInChannel,
} from "./livekit-bot.js";
import { createTestTone } from "./test-tone.js";

const FAKE_SECRET = "probe-test-secret-must-never-leak-0123456789";
const testEnv = {
  LIVEKIT_URL: "wss://probe-test.invalid",
  LIVEKIT_API_KEY: "probe-test-key",
  LIVEKIT_API_SECRET: FAKE_SECRET,
};

function decodeJwtPayload(jwt) {
  const payload = jwt.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

// ---------- mock RTC 模块 ----------

function createMockRtc({
  failConnect = false,
  failPublish = false,
  onCaptureFrame = null,
} = {}) {
  const log = [];
  const captured = { tokens: [], frames: [] };

  class MockRoom {
    constructor() {
      this.localParticipant = undefined;
    }

    async connect(url, token, opts) {
      log.push({ event: "connect", url, autoSubscribe: opts?.autoSubscribe });
      captured.tokens.push(token);
      if (failConnect) throw new Error("mock: connect refused");
      this.localParticipant = {
        publishTrack: async (track, options) => {
          log.push({
            event: "publish",
            trackName: track.name,
            source: options.source,
          });
          if (failPublish) throw new Error("mock: publish refused");
          return { sid: "MOCK_PUBLICATION_SID" };
        },
        unpublishTrack: async (sid, stopOnUnpublish) => {
          log.push({ event: "unpublish", sid, stopOnUnpublish });
        },
      };
    }

    async disconnect() {
      log.push({ event: "disconnect" });
    }
  }

  class MockAudioSource {
    constructor(sampleRate, numChannels, queueSize) {
      log.push({ event: "source-created", sampleRate, numChannels, queueSize });
    }

    async captureFrame(frame) {
      log.push({ event: "frame", firstSample: frame.data[0] });
      captured.frames.push(frame);
      onCaptureFrame?.(captured.frames.length);
    }

    async waitForPlayout() {
      log.push({ event: "playout" });
    }

    async close() {
      log.push({ event: "source-close" });
    }
  }

  class MockAudioFrame {
    constructor(data, sampleRate, channels, samplesPerChannel) {
      this.data = data;
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.samplesPerChannel = samplesPerChannel;
    }
  }

  class MockLocalAudioTrack {
    static createAudioTrack(name, source) {
      log.push({ event: "track-created", name });
      return { name, source };
    }
  }

  class MockTrackPublishOptions {
    constructor(fields = {}) {
      Object.assign(this, fields);
    }
  }

  const rtc = {
    Room: MockRoom,
    AudioSource: MockAudioSource,
    AudioFrame: MockAudioFrame,
    LocalAudioTrack: MockLocalAudioTrack,
    TrackPublishOptions: MockTrackPublishOptions,
    TrackSource: { SOURCE_MICROPHONE: "SOURCE_MICROPHONE" },
  };

  return { rtc, log, captured };
}

function eventNames(log) {
  return log.map((entry) => entry.event);
}

// ---------- token ----------

test("机器人 identity 固定且格式为 music-bot:<channelId>", () => {
  assert.equal(getMusicBotIdentity("lobby"), "music-bot:lobby");
  assert.equal(getMusicBotIdentity("lobby"), getMusicBotIdentity("lobby"));
  assert.notEqual(getMusicBotIdentity("a"), getMusicBotIdentity("b"));
});

test("机器人 token：identity、name、metadata 和最小权限", async () => {
  const jwt = await buildMusicBotToken("channel-42", testEnv);
  const payload = decodeJwtPayload(jwt);

  assert.equal(payload.sub, "music-bot:channel-42");
  assert.equal(payload.name, MUSIC_BOT_NAME);
  assert.equal(payload.iss, "probe-test-key");

  const metadata = JSON.parse(payload.metadata);
  assert.equal(metadata.displayName, MUSIC_BOT_NAME);
  assert.equal(metadata.isMusicBot, true);

  const grant = payload.video;
  assert.equal(grant.room, "channel-42");
  assert.equal(grant.roomJoin, true);
  assert.equal(grant.canPublish, true);
  assert.equal(grant.canSubscribe, false);
  assert.equal(grant.canPublishData, false);
  // 无管理员或跨房间权限
  assert.ok(!grant.roomAdmin);
  assert.ok(!grant.roomCreate);
  assert.ok(!grant.roomList);
});

test("缺少 LiveKit 配置时报 LIVEKIT_NOT_CONFIGURED", async () => {
  for (const env of [
    {},
    { LIVEKIT_URL: "wss://x" },
    { LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k" },
  ]) {
    await assert.rejects(
      () => playTestToneInChannel({ channelId: "c1", env }),
      (error) => error.code === MUSIC_BOT_ERROR.NOT_CONFIGURED
    );
  }
});

test("RTC 模块加载失败时报 LIVEKIT_RTC_UNAVAILABLE", async () => {
  await assert.rejects(
    () =>
      playTestToneInChannel({
        channelId: "c1",
        durationSeconds: 1,
        env: testEnv,
        loadRtc: async () => {
          throw new Error("native module missing");
        },
      }),
    (error) =>
      error.code === MUSIC_BOT_ERROR.RTC_UNAVAILABLE &&
      !error.message.includes(FAKE_SECRET)
  );
});

// ---------- 成功路径 ----------

test("成功路径：连接、发布、按序推帧、清理、状态顺序", async () => {
  const { rtc, log, captured } = createMockRtc();
  const statuses = [];

  const result = await playTestToneInChannel({
    channelId: "channel-ok",
    durationSeconds: 1,
    env: testEnv,
    loadRtc: async () => rtc,
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(result.aborted, false);
  assert.equal(result.framesSent, 100);
  assert.equal(result.totalFrames, 100);
  assert.equal(result.identity, "music-bot:channel-ok");

  // 事件顺序
  const names = eventNames(log);
  assert.deepEqual(names.slice(0, 3), [
    "connect",
    "source-created",
    "track-created",
  ]);
  assert.equal(names[3], "publish");
  assert.equal(names.filter((name) => name === "frame").length, 100);
  assert.deepEqual(names.slice(-4), [
    "playout",
    "unpublish",
    "source-close",
    "disconnect",
  ]);

  // 连接参数：不订阅他人音频
  const connectEvent = log.find((entry) => entry.event === "connect");
  assert.equal(connectEvent.url, testEnv.LIVEKIT_URL);
  assert.equal(connectEvent.autoSubscribe, false);

  // 音轨来源为 SOURCE_MICROPHONE，前端可识别为远端音频轨
  const publishEvent = log.find((entry) => entry.event === "publish");
  assert.equal(publishEvent.source, "SOURCE_MICROPHONE");

  // unpublish 使用 publication sid 并停止轨道
  const unpublishEvent = log.find((entry) => entry.event === "unpublish");
  assert.equal(unpublishEvent.sid, "MOCK_PUBLICATION_SID");
  assert.equal(unpublishEvent.stopOnUnpublish, true);

  // PCM 帧按顺序提交且与测试音一致
  const tone = createTestTone({ durationSeconds: 1 });
  assert.equal(captured.frames.length, 100);
  for (const index of [0, 1, 50, 99]) {
    const frame = captured.frames[index];
    assert.ok(frame.data instanceof Int16Array);
    assert.equal(frame.sampleRate, 48000);
    assert.equal(frame.channels, 1);
    assert.equal(frame.samplesPerChannel, 480);
    assert.deepEqual(frame.data, tone.frameAt(index));
  }

  // 状态顺序
  assert.deepEqual(statuses, [
    "connecting",
    "connected",
    "published",
    "completed",
    "disconnected",
  ]);
});

// ---------- 失败与中止路径 ----------

test("连接失败：报 MUSIC_BOT_CONNECT_FAILED 且清理资源", async () => {
  const { rtc, log } = createMockRtc({ failConnect: true });
  const statuses = [];

  await assert.rejects(
    () =>
      playTestToneInChannel({
        channelId: "channel-bad",
        durationSeconds: 1,
        env: testEnv,
        loadRtc: async () => rtc,
        onStatus: (status) => statuses.push(status),
      }),
    (error) =>
      error.code === MUSIC_BOT_ERROR.CONNECT_FAILED &&
      !error.message.includes(FAKE_SECRET)
  );

  const names = eventNames(log);
  assert.ok(!names.includes("publish"));
  assert.ok(!names.includes("frame"));
  // 异常路径也断开房间
  assert.ok(names.includes("disconnect"));
  assert.deepEqual(statuses, ["connecting", "disconnected"]);
});

test("发布失败：报 MUSIC_BOT_PUBLISH_FAILED 且清理 source 和房间", async () => {
  const { rtc, log } = createMockRtc({ failPublish: true });

  await assert.rejects(
    () =>
      playTestToneInChannel({
        channelId: "channel-pub",
        durationSeconds: 1,
        env: testEnv,
        loadRtc: async () => rtc,
      }),
    (error) => error.code === MUSIC_BOT_ERROR.PUBLISH_FAILED
  );

  const names = eventNames(log);
  assert.ok(!names.includes("frame"));
  assert.ok(names.includes("source-close"));
  assert.ok(names.includes("disconnect"));
});

test("SIGINT 中止路径：提前结束且完整清理", async () => {
  const abortController = new AbortController();
  const { rtc, log } = createMockRtc({
    onCaptureFrame: (count) => {
      // 模拟推流中收到 SIGINT
      if (count === 3) abortController.abort();
    },
  });
  const statuses = [];

  const result = await playTestToneInChannel({
    channelId: "channel-abort",
    durationSeconds: 5,
    env: testEnv,
    loadRtc: async () => rtc,
    signal: abortController.signal,
    onStatus: (status) => statuses.push(status),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.framesSent, 3);
  assert.ok(result.framesSent < result.totalFrames);

  const names = eventNames(log);
  assert.ok(names.includes("unpublish"));
  assert.ok(names.includes("source-close"));
  assert.ok(names.includes("disconnect"));
  assert.ok(statuses.includes("aborted"));
  assert.equal(statuses.at(-1), "disconnected");
});

test("状态输出与错误信息不包含 token 和 API secret", async () => {
  const { rtc, captured } = createMockRtc();
  const statuses = [];

  await playTestToneInChannel({
    channelId: "channel-leak-check",
    durationSeconds: 1,
    env: testEnv,
    loadRtc: async () => rtc,
    onStatus: (status) => statuses.push(String(status)),
  });

  // mock 收到了真实签发的 JWT
  assert.equal(captured.tokens.length, 1);
  const token = captured.tokens[0];
  assert.ok(token.split(".").length === 3);

  for (const status of statuses) {
    assert.ok(!status.includes(FAKE_SECRET));
    assert.ok(!status.includes(token));
  }

  const { rtc: failRtc } = createMockRtc({ failConnect: true });
  try {
    await playTestToneInChannel({
      channelId: "channel-leak-check",
      durationSeconds: 1,
      env: testEnv,
      loadRtc: async () => failRtc,
    });
    assert.fail("应当抛出连接失败");
  } catch (error) {
    assert.ok(!String(error.message).includes(FAKE_SECRET));
    assert.ok(!String(error.stack || "").includes(FAKE_SECRET));
  }
});

test("channelId 缺失或非法时直接拒绝", async () => {
  for (const bad of [undefined, null, "", "   ", 42]) {
    await assert.rejects(
      () => playTestToneInChannel({ channelId: bad, env: testEnv }),
      (error) => error.code === MUSIC_BOT_ERROR.NOT_CONFIGURED
    );
  }
});
