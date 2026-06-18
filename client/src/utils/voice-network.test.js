import assert from "node:assert/strict";
import test from "node:test";
import { calculateLossSample, formatLoss, smoothMetric, weightedLoss } from "./voice-network.js";

test("first cumulative sample establishes a baseline", () => {
  assert.equal(calculateLossSample({ packetsSent: 100, packetsLost: 5, timestamp: 2 }, null, "packetsSent"), null);
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
