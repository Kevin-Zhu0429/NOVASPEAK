import { formatLoss, metricSeverity, qualityLabel } from "../../utils/voice-network";

export default function NetworkStats({ stats, quality }) {
  const rtt = Number.isFinite(stats.rtt) ? `${Math.round(stats.rtt)} ms` : "--";
  return (
    <details className="network-stats">
      <summary>{rtt} · {formatLoss(stats.outboundLoss)} loss</summary>
      <div className="network-stats-grid">
        <span className={metricSeverity(stats.rtt, "rtt")}><small>RTT</small>{rtt}</span>
        <span className={metricSeverity(stats.outboundLoss, "loss")}><small>上行丢包</small>{formatLoss(stats.outboundLoss)}</span>
        <span className={metricSeverity(stats.inboundLoss, "loss")}><small>下行丢包</small>{formatLoss(stats.inboundLoss)}</span>
        <span><small>网络</small>{qualityLabel(quality)}</span>
      </div>
    </details>
  );
}
