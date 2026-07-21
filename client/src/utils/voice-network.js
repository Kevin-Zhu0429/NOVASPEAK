import { ConnectionQuality } from "livekit-client";

export const NETWORK_POLL_INTERVAL_MS = 2000;
export const NETWORK_SMOOTHING_ALPHA = 0.3;

function isAudioRtp(stat, knownAudioTrack = false) {
  return stat?.kind === "audio" || stat?.mediaType === "audio" || (knownAudioTrack && !stat?.kind && !stat?.mediaType);
}

export function reportValues(report) {
  return report ? Array.from(report.values?.() || report) : [];
}

export function findOutboundAudio(report) {
  return reportValues(report).find((stat) => stat.type === "outbound-rtp" && isAudioRtp(stat, true)) || null;
}

export function findRemoteInboundAudio(report, outbound) {
  if (!outbound) return null;
  const candidates = reportValues(report).filter((stat) => stat.type === "remote-inbound-rtp" && isAudioRtp(stat, true));
  return candidates.find((stat) => outbound.remoteId && stat.id === outbound.remoteId)
    || candidates.find((stat) => stat.localId && stat.localId === outbound.id)
    || candidates.find((stat) => Number.isFinite(outbound.ssrc) && Number(stat.ssrc) === Number(outbound.ssrc))
    || (candidates.length === 1 ? candidates[0] : null);
}

export function readRtt(remoteInbound) {
  const direct = Number(remoteInbound?.roundTripTime);
  if (Number.isFinite(direct) && direct >= 0) return direct * 1000;
  const total = Number(remoteInbound?.totalRoundTripTime);
  const measurements = Number(remoteInbound?.roundTripTimeMeasurements);
  return Number.isFinite(total) && total >= 0 && Number.isFinite(measurements) && measurements > 0
    ? (total / measurements) * 1000
    : null;
}

// 判断相邻两次 stats 是否属于同一条 RTP 流：report id 或 SSRC 任一变化
// （音轨重发布、重协商、重连）都说明累计计数已重置，不能再做 delta。
export function isSameRtpStream(current, previous) {
  if (!current || !previous) return false;
  if (current.id && previous.id && current.id !== previous.id) return false;
  const currentSsrc = Number(current.ssrc);
  const previousSsrc = Number(previous.ssrc);
  if (Number.isFinite(currentSsrc) && Number.isFinite(previousSsrc) && currentSsrc !== previousSsrc) {
    return false;
  }
  return true;
}

// 连续多少次 poll 无有效上行样本后，不再保留旧的丢包显示值。
// 静音麦克风、无 outbound 包或统计缺失时，旧的严重丢包不能一直挂在面板上。
export const LOSS_MAX_STALE_POLLS = 3;

export function nextLossValue(previousLoss, sample, stalePollCount) {
  if (sample) return smoothMetric(previousLoss, sample.loss);
  return stalePollCount >= LOSS_MAX_STALE_POLLS ? null : previousLoss ?? null;
}

export function outboundLossSample(currentOutbound, previousOutbound, currentRemote, previousRemote) {
  if (!currentOutbound || !previousOutbound || !currentRemote || !previousRemote) return null;
  if (!isSameRtpStream(currentOutbound, previousOutbound)) return null;
  if (!isSameRtpStream(currentRemote, previousRemote)) return null;
  const sent = Number(currentOutbound.packetsSent);
  const previousSent = Number(previousOutbound.packetsSent);
  const lost = Number(currentRemote.packetsLost);
  const previousLost = Number(previousRemote.packetsLost);
  const timestamp = Number(currentOutbound.timestamp);
  const previousTimestamp = Number(previousOutbound.timestamp);
  if (![sent, previousSent, lost, previousLost, timestamp, previousTimestamp].every(Number.isFinite)) return null;
  const sentDelta = sent - previousSent;
  const rawLostDelta = lost - previousLost;
  if (sentDelta < 0 || timestamp <= previousTimestamp) return null;
  const lostDelta = Math.max(0, rawLostDelta);
  const totalDelta = sentDelta + lostDelta;
  if (totalDelta <= 0) return null;
  return { loss: Math.min(100, (lostDelta / totalDelta) * 100), totalDelta };
}

export function findInboundAudio(report) {
  return reportValues(report).find((stat) => stat.type === "inbound-rtp" && isAudioRtp(stat, true)) || null;
}

export function calculateLossSample(current, previous, packetField) {
  if (!current || !previous) return null;
  if (!isSameRtpStream(current, previous)) return null;
  if (current.packetsLost == null || previous.packetsLost == null) return null;
  const packets = Number(current[packetField]);
  const lost = Number(current.packetsLost);
  const timestamp = Number(current.timestamp);
  const previousPackets = Number(previous[packetField]);
  const previousLost = Number(previous.packetsLost);
  const previousTimestamp = Number(previous.timestamp);
  if (![packets, lost, timestamp, previousPackets, previousLost, previousTimestamp].every(Number.isFinite)) return null;
  const packetDelta = packets - previousPackets;
  const lostDelta = lost - previousLost;
  if (packetDelta < 0 || timestamp <= previousTimestamp) return null;
  const safeLostDelta = Math.max(0, lostDelta);
  const totalDelta = packetDelta + safeLostDelta;
  if (totalDelta <= 0) return null;
  return { loss: Math.min(100, (safeLostDelta / totalDelta) * 100), totalDelta };
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
