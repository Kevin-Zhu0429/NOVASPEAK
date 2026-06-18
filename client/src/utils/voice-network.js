import { ConnectionQuality } from "livekit-client";

export const NETWORK_POLL_INTERVAL_MS = 2000;
export const NETWORK_SMOOTHING_ALPHA = 0.3;

export function calculateLossSample(current, previous, packetField) {
  if (!current || !previous) return null;
  const packets = Number(current[packetField]);
  const lost = Number(current.packetsLost);
  const timestamp = Number(current.timestamp);
  const previousPackets = Number(previous[packetField]);
  const previousLost = Number(previous.packetsLost);
  const previousTimestamp = Number(previous.timestamp);
  if (![packets, lost, timestamp, previousPackets, previousLost, previousTimestamp].every(Number.isFinite)) return null;
  const packetDelta = packets - previousPackets;
  const lostDelta = lost - previousLost;
  if (packetDelta < 0 || lostDelta < 0 || timestamp <= previousTimestamp) return null;
  const totalDelta = packetDelta + lostDelta;
  if (totalDelta <= 0) return null;
  return { loss: Math.min(100, Math.max(0, (lostDelta / totalDelta) * 100)), totalDelta };
}

export function weightedLoss(samples) {
  const valid = samples.filter((sample) => sample && Number.isFinite(sample.loss) && sample.totalDelta > 0);
  if (!valid.length) return null;
  const total = valid.reduce((sum, sample) => sum + sample.totalDelta, 0);
  return valid.reduce((sum, sample) => sum + sample.loss * sample.totalDelta, 0) / total;
}

export function smoothMetric(previous, current, alpha = NETWORK_SMOOTHING_ALPHA) {
  if (!Number.isFinite(current)) return previous ?? null;
  if (!Number.isFinite(previous)) return current;
  return alpha * current + (1 - alpha) * previous;
}

export function formatLoss(value) {
  if (!Number.isFinite(value) || value < 0) return "--";
  const safe = Math.min(100, value);
  return safe < 0.1 ? "<0.1%" : `${safe.toFixed(1)}%`;
}

export function qualityLabel(quality) {
  switch (quality) {
    case ConnectionQuality.Excellent: return "优秀";
    case ConnectionQuality.Good: return "良好";
    case ConnectionQuality.Poor: return "较差";
    case ConnectionQuality.Lost: return "已中断";
    default: return "未知";
  }
}

export function metricSeverity(value, type) {
  if (!Number.isFinite(value)) return "unknown";
  if (type === "rtt") {
    if (value < 80) return "excellent";
    if (value < 150) return "good";
    if (value < 250) return "poor";
    return "severe";
  }
  if (value < 1) return "excellent";
  if (value < 3) return "good";
  if (value < 8) return "poor";
  return "severe";
}
