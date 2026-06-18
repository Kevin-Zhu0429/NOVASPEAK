import { formatLoss, metricSeverity, qualityLabel } from "../../utils/voice-network";

function NetworkStatsGrid({ stats, quality, rtt, localHint, inboundHint }) {
  return (
    <div className="network-stats-grid">
      <span title={localHint} className={metricSeverity(stats.rtt, "rtt")}><small>RTT</small>{rtt}</span>
      <span title={localHint} className={metricSeverity(stats.outboundLoss, "loss")}><small>上行丢包</small>{formatLoss(stats.outboundLoss)}</span>
      <span title={inboundHint} className={metricSeverity(stats.inboundLoss, "loss")}><small>下行丢包</small>{formatLoss(stats.inboundLoss)}</span>
      <span><small>网络</small>{qualityLabel(quality)}</span>
    </div>
  );
}


export default function NetworkStats({ stats, quality }) {
  const rtt = Number.isFinite(stats.rtt) ? `${Math.round(stats.rtt)} ms` : "--";
  const localHint = stats.localStatus === "waiting-local-track" ? "等待麦克风"
    : stats.localStatus === "waiting-first-sample" ? "等待统计采样"
      : stats.localStatus === "stats-unavailable" ? "浏览器未提供发送统计" : "本地发送统计";
  const inboundHint = stats.inboundStatus === "no-remote-audio" ? "暂无远端音频"
    : stats.inboundStatus === "waiting-first-sample" ? "等待远端统计采样"
      : stats.inboundStatus === "stats-unavailable" ? "浏览器未提供接收统计" : "远端接收统计";
  const gridProps = { stats, quality, rtt, localHint, inboundHint };
  return (
    <>
      <div className="network-stats network-stats-desktop">
        <NetworkStatsGrid {...gridProps} />
      </div>
      <details className="network-stats network-stats-compact">
        <summary>{rtt} · {formatLoss(stats.outboundLoss)} loss</summary>
        <NetworkStatsGrid {...gridProps} />
      </details>
    </>
  );
}
