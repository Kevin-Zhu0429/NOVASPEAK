import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateLossSample,
  findInboundAudio,
  findOutboundAudio,
  findRemoteInboundAudio,
  formatLoss,
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
