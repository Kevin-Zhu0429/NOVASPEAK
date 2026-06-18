import { memo } from "react";
import { Mic, MicOff, Signal } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";

function VoiceParticipantCard({ item, receiveLoss }) {
  return (
    <article className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""}`}>
      <div className="voice-avatar">{item.displayName.slice(0, 1).toUpperCase()}</div>
      <div className="voice-participant-copy">
        <strong>{item.displayName}{item.isLocal ? "（我）" : ""}</strong>
        <span>{item.positionText}</span>
        <small>{item.isSpeaking ? "正在说话" : item.microphoneEnabled ? "麦克风开启" : "麦克风关闭"}</small>
        {!item.isLocal && Number.isFinite(receiveLoss) && <small>本机接收丢包 {formatLoss(receiveLoss)}</small>}
      </div>
      <div className="voice-participant-state" title={`网络质量：${qualityLabel(item.connectionQuality)}`}>
        <Signal size={17} /><span>{qualityLabel(item.connectionQuality)}</span>
        {item.microphoneEnabled ? <Mic size={17} /> : <MicOff size={17} />}
      </div>
      {item.isSpeaking && <div className="voice-level" style={{ "--voice-level": Math.max(0.12, item.audioLevel) }} />}
    </article>
  );
}
export default memo(VoiceParticipantCard);
