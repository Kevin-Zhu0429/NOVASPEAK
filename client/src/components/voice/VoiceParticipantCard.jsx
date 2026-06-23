import { memo, useEffect, useRef, useState } from "react";
import { Mic, MicOff, MoreHorizontal, Signal } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";

function VoiceParticipantCard({ item, receiveLoss, currentUser, currentChannel, channels, busy, anyBusy, onManageParticipant }) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef(null);
  const canManage = !item.isLocal && ["admin", "member"].includes(currentUser?.role);
  const canServerMute = canManage && currentUser?.role === "admin";
  const targetChannels = channels.filter((channel) => channel.id !== currentChannel.id);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "mousedown" && !menuRef.current?.contains(event.target))) {
        setOpen(false);
        setMoveOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const run = (action, targetChannelId) => {
    setOpen(false);
    setMoveOpen(false);
    onManageParticipant(action, item, targetChannelId);
  };

  return (
    <article className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""} ${busy ? "operating" : ""}`}>
      <div className="voice-avatar">{item.displayName.slice(0, 1).toUpperCase()}</div>
      <div className="voice-participant-copy">
        <strong>{item.displayName}{item.isLocal ? "（我）" : ""}</strong>
        <span>{item.positionText}</span>
        <small>{busy ? "操作中..." : item.serverMuted ? "已被服务器静音" : item.isSpeaking ? "正在说话" : item.microphoneEnabled ? "麦克风开启" : "麦克风关闭"}</small>
        {!item.isLocal && Number.isFinite(receiveLoss) && <small>本机接收丢包 {formatLoss(receiveLoss)}</small>}
      </div>
      <div className="voice-participant-state" title={`网络质量：${qualityLabel(item.connectionQuality)}`}>
        <Signal size={17} /><span>{qualityLabel(item.connectionQuality)}</span>
        {item.microphoneEnabled && !item.serverMuted ? <Mic size={17} /> : <MicOff size={17} />}
      </div>
      {canManage && (
        <div className="voice-member-actions" ref={menuRef}>
          <button type="button" className="voice-member-menu-button" onClick={() => setOpen((value) => !value)} disabled={busy || anyBusy} aria-label="成员操作菜单">
            <MoreHorizontal size={17} />
          </button>
          {open && (
            <div className="voice-member-menu">
              {canServerMute && (
                <button type="button" disabled={busy || anyBusy} onClick={() => run(item.serverMuted ? "unmute" : "mute")}>{item.serverMuted ? "解除服务器静音" : "服务器静音"}</button>
              )}
              <button type="button" disabled={busy || anyBusy} onClick={() => setMoveOpen((value) => !value)}>移动到其他频道</button>
              {moveOpen && (
                <div className="voice-channel-submenu">
                  {targetChannels.map((channel) => <button key={channel.id} type="button" disabled={busy || anyBusy} onClick={() => run("move", channel.id)}>{channel.name}</button>)}
                  {targetChannels.length === 0 && <span>没有可移动的频道</span>}
                </div>
              )}
              <button type="button" disabled={busy || anyBusy} onClick={() => run("remove")}>移出当前频道</button>
            </div>
          )}
        </div>
      )}
      {item.serverMuted && <div className="server-muted-badge">服务器静音</div>}
      {item.isSpeaking && <div className="voice-level" style={{ "--voice-level": Math.max(0.12, item.audioLevel) }} />}
    </article>
  );
}
export default memo(VoiceParticipantCard);
