import assert from "node:assert/strict";
import test from "node:test";
import {
  LOSS_MAX_STALE_POLLS,
  calculateLossSample,
  findInboundAudio,
  findOutboundAudio,
  findRemoteInboundAudio,
  formatLoss,
  isSameRtpStream,
  nextLossValue,
  outboundLossSample,
  readRtt,
  smoothMetric,
  weightedLoss,
} from "./voice-network.js";

function report(...stats) {
  return new Map(stats.map((stat) => [stat.id, stat]));
}

test("matches outbound audio to its remote inbound report", () => {
  const stats = report(
    { id: "out", type: "outbound-rtp", kind: "audio", remoteId: "remote", packetsSent: 10 },
    { id: "other", type: "remote-inbound-rtp", kind: "video", packetsLost: 8 },
    { id: "remote", type: "remote-inbound-rtp", kind: "audio", packetsLost: 1 },
  );
  const outbound = findOutboundAudio(stats);
  assert.equal(outbound.id, "out");
  assert.equal(findRemoteInboundAudio(stats, outbound).id, "remote");
});

test("reads direct RTT and average RTT fallback", () => {
  assert.equal(readRtt({ roundTripTime: 0.125 }), 125);
  assert.equal(readRtt({ totalRoundTripTime: 0.9, roundTripTimeMeasurements: 3 }), 300);
});

test("outbound loss combines sent and remotely reported lost deltas", () => {
  const sample = outboundLossSample(
    { packetsSent: 190, timestamp: 4 },
    { packetsSent: 100, timestamp: 2 },
    { packetsLost: 10 },
    { packetsLost: 5 },
  );
  assert.equal(sample.totalDelta, 95);
  assert.equal(Number(sample.loss.toFixed(4)), Number(((5 / 95) * 100).toFixed(4)));
});

test("missing outbound packetsLost report remains unavailable", () => {
  assert.equal(outboundLossSample(
    { packetsSent: 190, timestamp: 4 },
    { packetsSent: 100, timestamp: 2 },
    {},
    {},
  ), null);
});

test("negative remote loss delta is clamped without a false spike", () => {
  assert.equal(outboundLossSample(
    { packetsSent: 200, timestamp: 4 },
    { packetsSent: 100, timestamp: 2 },
    { packetsLost: -1 },
    { packetsLost: 2 },
  ).loss, 0);
});

test("known remote audio track accepts inbound RTP without kind", () => {
  assert.equal(findInboundAudio(report({
    id: "inbound",
    type: "inbound-rtp",
    packetsReceived: 10,
    packetsLost: 0,
  })).id, "inbound");
});

test("first cumulative sample establishes a baseline", () => {
  assert.equal(calculateLossSample({ packetsSent: 100, packetsLost: 5, timestamp: 2 }, null, "packetsSent"), null);
});

test("second sample displays zero percent instead of unavailable", () => {
  assert.equal(calculateLossSample(
    { packetsReceived: 20, packetsLost: 0, timestamp: 4 },
    { packetsReceived: 10, packetsLost: 0, timestamp: 2 },
    "packetsReceived",
  ).loss, 0);
});

test("missing packetsLost is unavailable instead of being coerced to zero", () => {
  assert.equal(calculateLossSample(
    { packetsReceived: 20, timestamp: 4 },
    { packetsReceived: 10, timestamp: 2 },
    "packetsReceived",
  ), null);
});

test("loss uses adjacent counter deltas", () => {
  const sample = calculateLossSample(
    { packetsSent: 190, packetsLost: 10, timestamp: 4 },
    { packetsSent: 100, packetsLost: 5, timestamp: 2 },
    "packetsSent",
  );
  assert.equal(sample.totalDelta, 95);
  assert.equal(Number(sample.loss.toFixed(4)), Number(((5 / 95) * 100).toFixed(4)));
});

test("counter or timestamp resets do not produce false spikes", () => {
  assert.equal(calculateLossSample({ packetsReceived: 2, packetsLost: 0, timestamp: 4 }, { packetsReceived: 50, packetsLost: 2, timestamp: 3 }, "packetsReceived"), null);
  assert.equal(calculateLossSample({ packetsReceived: 60, packetsLost: 3, timestamp: 2 }, { packetsReceived: 50, packetsLost: 2, timestamp: 3 }, "packetsReceived"), null);
});

test("multiple inbound tracks are packet weighted", () => {
  assert.equal(weightedLoss([{ loss: 10, totalDelta: 10 }, { loss: 1, totalDelta: 90 }]), 1.9);
});

test("formatting and smoothing reject unstable display values", () => {
  assert.equal(formatLoss(Number.NaN), "--");
  assert.equal(formatLoss(0), "<0.1%");
  assert.equal(formatLoss(120), "100.0%");
  assert.equal(smoothMetric(10, 20), 13);
});

test("report id 或 SSRC 变化时判定为不同 RTP 流", () => {
  assert.equal(isSameRtpStream({ id: "a" }, { id: "a" }), true);
  assert.equal(isSameRtpStream({ id: "a" }, { id: "b" }), false);
  assert.equal(isSameRtpStream({ id: "a", ssrc: 111 }, { id: "a", ssrc: 222 }), false);
  // 没有 id/ssrc 字段时不误杀（旧浏览器 stats 缺字段）
  assert.equal(isSameRtpStream({}, {}), true);
  assert.equal(isSameRtpStream(null, {}), false);
});

test("outbound SSRC / report id 改变时不与旧累计值计算，只重建基线", () => {
  const previousOutbound = { id: "out-1", ssrc: 111, packetsSent: 1000, timestamp: 1 };
  const previousRemote = { id: "rem-1", ssrc: 111, packetsLost: 500, timestamp: 1 };
  // 音轨重发布后新 SSRC 从零开始计数：绝不能得出虚假 40%+ 丢包
  const rebornOutbound = { id: "out-2", ssrc: 222, packetsSent: 100, timestamp: 2 };
  const rebornRemote = { id: "rem-2", ssrc: 222, packetsLost: 0, timestamp: 2 };
  assert.equal(outboundLossSample(rebornOutbound, previousOutbound, rebornRemote, previousRemote), null);
});

test("remote-inbound report id 改变时不与旧累计值计算", () => {
  const outbound = { id: "out-1", packetsSent: 200, timestamp: 2 };
  const previousOutbound = { id: "out-1", packetsSent: 100, timestamp: 1 };
  const remote = { id: "rem-2", packetsLost: 90, timestamp: 2 };
  const previousRemote = { id: "rem-1", packetsLost: 0, timestamp: 1 };
  assert.equal(outboundLossSample(outbound, previousOutbound, remote, previousRemote), null);
});

test("inbound report 跨 SSRC 时同样重建基线", () => {
  assert.equal(
    calculateLossSample(
      { id: "in-2", ssrc: 222, packetsReceived: 10, packetsLost: 9, timestamp: 2 },
      { id: "in-1", ssrc: 111, packetsReceived: 900, packetsLost: 1, timestamp: 1 },
      "packetsReceived"
    ),
    null
  );
});

test("无新样本时丢包显示最多保留 LOSS_MAX_STALE_POLLS 个周期", () => {
  // 有样本：正常平滑并清零陈旧计数
  assert.equal(nextLossValue(10, { loss: 20 }, 0), smoothMetric(10, 20));
  // 无样本：短暂保留旧值
  assert.equal(nextLossValue(42, null, LOSS_MAX_STALE_POLLS - 1), 42);
  // 达到阈值：不再显示旧的严重丢包
  assert.equal(nextLossValue(42, null, LOSS_MAX_STALE_POLLS), null);
  assert.equal(nextLossValue(42, null, LOSS_MAX_STALE_POLLS + 5), null);
  // 一直没有值时保持 null
  assert.equal(nextLossValue(null, null, 0), null);
});
