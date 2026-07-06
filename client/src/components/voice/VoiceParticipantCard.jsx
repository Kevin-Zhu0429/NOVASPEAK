import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, MoreHorizontal, Signal } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";
import { getParticipantContextMenuItems } from "../../utils/voice-member-menu";
import VoiceParticipantProfileModal from "./VoiceParticipantProfileModal";

function clampMenuPosition(x, y, width = 240, height = 360) {
  const margin = 10;
  return {
    left: Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin)),
    top: Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - Math.min(height, window.innerHeight - margin * 2) - margin)),
  };
}

function VoiceParticipantCard({ item, receiveLoss, currentUser, currentChannel, channels, busy, anyBusy, onManageParticipant, onLocalAudioChange }) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({ top: 0, left: 0 });
  const menuItems = getParticipantContextMenuItems({ item, currentUser, currentChannel, channels });
  const canManage = menuItems.some((entry) => ["mute", "unmute", "move", "remove"].includes(entry.action));
  const targetChannels = channels.filter((channel) => channel.id !== currentChannel.id);

  const updateMenuPosition = (anchor = buttonRef.current?.getBoundingClientRect()) => {
    if (!anchor) return;
    const height = Math.min(420, Math.max(210, 42 * menuItems.length + (moveOpen ? Math.max(1, targetChannels.length) * 38 : 0) + 86));
    const x = "right" in anchor ? anchor.right - 240 : anchor.x;
    const y = "bottom" in anchor ? anchor.bottom + 6 : anchor.y;
    setMenuStyle(clampMenuPosition(x, y, 240, height));
  };

  useLayoutEffect(() => { if (open) updateMenuPosition(); }, [open, moveOpen, targetChannels.length]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "mousedown" && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target))) {
        setOpen(false); setMoveOpen(false);
      }
    };
    const closeOnViewportChange = () => { setOpen(false); setMoveOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [open]);

  const openAt = (point) => { setOpen(true); setMoveOpen(false); setMenuStyle(clampMenuPosition(point.x, point.y)); };
  const run = (action, targetChannelId) => {
    if (action === "profile") { setProfileOpen(true); setOpen(false); return; }
    if (action === "local-mute") onLocalAudioChange?.(item, { muted: true });
    else if (action === "local-unmute") onLocalAudioChange?.(item, { muted: false });
    else onManageParticipant(action, item, targetChannelId);
    setOpen(false); setMoveOpen(false);
  };

  const menu = open ? (
    <div className="voice-member-menu voice-member-menu-portal" ref={menuRef} style={menuStyle}>
      <button type="button" onClick={() => run("profile")}>查看成员资料</button>
      {!item.isLocal && <button type="button" onClick={() => run(item.localMuted ? "local-unmute" : "local-mute")}>{item.localMuted ? "取消本地静音" : "本地静音"}</button>}
      {!item.isLocal && (
        <label className="voice-member-volume-control">
          <span>音量：{item.localVolume ?? 100}%</span>
          <input type="range" min="0" max="200" value={item.localVolume ?? 100} onChange={(event) => onLocalAudioChange?.(item, { volume: Number(event.target.value) })} />
          {(item.localVolume ?? 100) > 100 && <em>浏览器原生音量最高为 100%，更高增益后续再支持</em>}
        </label>
      )}
      {currentUser?.role === "admin" && !item.isLocal && <button type="button" disabled={busy || anyBusy} onClick={() => run(item.serverMuted ? "unmute" : "mute")}>{item.serverMuted ? "解除服务器静音" : "服务器静音"}</button>}
      {canManage && <button type="button" disabled={busy || anyBusy} onClick={() => setMoveOpen((value) => !value)}>移动到其他频道</button>}
      {moveOpen && <div className="voice-channel-submenu">{targetChannels.map((channel) => <button key={channel.id} type="button" disabled={busy || anyBusy} onClick={() => run("move", channel.id)}>{channel.name}</button>)}{targetChannels.length === 0 && <span>没有可移动的频道</span>}</div>}
      {canManage && <button type="button" disabled={busy || anyBusy} onClick={() => run("remove")}>移出当前频道</button>}
    </div>
  ) : null;

  return (
    <article className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""} ${busy ? "operating" : ""}`} onContextMenu={(event) => { event.preventDefault(); openAt({ x: event.clientX, y: event.clientY }); }}>
      <div className="voice-avatar">{item.displayName.slice(0, 1).toUpperCase()}</div>
      <div className="voice-participant-copy">
        <strong>{item.displayName}{item.isLocal ? "（我）" : ""}</strong>
        <span>{item.positionText}</span>
        <small>{busy ? "操作中..." : item.serverMuted ? "已被服务器静音" : item.localMuted && !item.isLocal ? "已本地静音" : item.isSpeaking ? "正在说话" : item.microphoneEnabled ? "麦克风开启" : "麦克风关闭"}</small>
        {!item.isLocal && Number.isFinite(receiveLoss) && <small>本机接收丢包 {formatLoss(receiveLoss)}</small>}
      </div>
      <div className="voice-participant-state" title={`网络质量：${qualityLabel(item.connectionQuality)}`}>
        <Signal size={17} /><span>{qualityLabel(item.connectionQuality)}</span>
        {item.microphoneEnabled && !item.serverMuted ? <Mic size={17} /> : <MicOff size={17} />}
      </div>
      <div className="voice-member-actions">
        <button ref={buttonRef} type="button" className="voice-member-menu-button" onClick={() => openAt(buttonRef.current?.getBoundingClientRect() || { x: 0, y: 0 })} disabled={busy || anyBusy} aria-label="成员操作菜单">
          <MoreHorizontal size={17} />
        </button>
        {menu && createPortal(menu, document.body)}
      </div>
      {item.serverMuted && <div className="server-muted-badge">服务器静音</div>}
      {item.localMuted && !item.isLocal && <div className="local-muted-badge">本地静音</div>}
      {item.isSpeaking && <div className="voice-level" style={{ "--voice-level": Math.max(0.12, item.audioLevel) }} />}
      {profileOpen && <VoiceParticipantProfileModal item={item} channel={currentChannel} onClose={() => setProfileOpen(false)} />}
    </article>
  );
}
export default memo(VoiceParticipantCard);
