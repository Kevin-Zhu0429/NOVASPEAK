import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, MoreHorizontal, Signal } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";
import { getMemberStatusBadges, getParticipantMenuActions } from "../../utils/voice-member-menu";
import { getMemberAudioKey, getMemberAudioPref } from "../../utils/local-audio-preferences";
import VoiceMemberContextMenu from "./VoiceMemberContextMenu";
import MemberProfileDialog from "./MemberProfileDialog";

function VoiceParticipantCard({ item, receiveLoss, currentUser, currentChannel, channels, busy, anyBusy, onManageParticipant, localAudioPrefs, onSetMemberVolume, onSetMemberLocalMuted }) {
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const memberKey = getMemberAudioKey(item);
  const localPref = getMemberAudioPref(localAudioPrefs, memberKey);
  const statusBadges = getMemberStatusBadges({ serverMuted: item.serverMuted, localMuted: !item.isLocal && localPref.muted });
  const menuRef = useRef(null);
  const buttonRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({ top: 0, left: 0 });
  const menuActions = getParticipantMenuActions({ item, currentUser, currentChannel, channels });
  const canManage = menuActions.length > 0;
  const canServerMute = currentUser?.role === "admin" && canManage;
  const targetChannels = channels.filter((channel) => channel.id !== currentChannel.id);

  const updateMenuPosition = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = 220;
    const estimatedHeight = Math.min(360, Math.max(168, 44 * (canServerMute ? 3 : 2) + (moveOpen ? Math.max(1, targetChannels.length) * 38 : 0) + 18));
    const margin = 10;
    const left = Math.min(Math.max(margin, rect.right - menuWidth), window.innerWidth - menuWidth - margin);
    const opensUp = rect.bottom + estimatedHeight + margin > window.innerHeight;
    const top = opensUp ? Math.max(margin, rect.top - estimatedHeight - 6) : Math.min(rect.bottom + 6, window.innerHeight - margin);
    setMenuStyle({ top, left });
  };

  useLayoutEffect(() => {
    if (open) updateMenuPosition();
  }, [open, moveOpen, targetChannels.length]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "mousedown" && !menuRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target))) {
        setOpen(false);
        setMoveOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    const reposition = () => updateMenuPosition();
    document.addEventListener("keydown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, moveOpen, targetChannels.length]);

  const run = (action, targetChannelId) => {
    setOpen(false);
    setMoveOpen(false);
    onManageParticipant(action, item, targetChannelId);
  };

  const menu = open ? (
    <div className="voice-member-menu voice-member-menu-portal" ref={menuRef} style={menuStyle}>
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
  ) : null;

  const openContextMenu = (event) => {
    event.preventDefault();
    // Portal 内的右键事件会沿 React 树冒泡回卡片，不重新打开菜单
    if (event.target instanceof Element && event.target.closest(".voice-member-menu, .member-profile-overlay")) return;
    setOpen(false);
    setMoveOpen(false);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  return (
    <article className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""} ${busy ? "operating" : ""}`} onContextMenu={openContextMenu}>
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
        <div className="voice-member-actions">
          <button ref={buttonRef} type="button" className="voice-member-menu-button" onClick={() => setOpen((value) => !value)} disabled={busy || anyBusy} aria-label="成员操作菜单">
            <MoreHorizontal size={17} />
          </button>
          {menu && createPortal(menu, document.body)}
        </div>
      )}
      {statusBadges.length > 0 && (
        <div className="voice-card-badges">
          {statusBadges.map((badge) => <div key={badge.type} className={`${badge.type}-badge`}>{badge.label}</div>)}
        </div>
      )}
      {item.isSpeaking && <div className="voice-level" style={{ "--voice-level": Math.max(0.12, item.audioLevel) }} />}
      {contextMenu && (
        <VoiceMemberContextMenu
          position={contextMenu}
          item={item}
          currentUser={currentUser}
          currentChannel={currentChannel}
          channels={channels}
          localPref={localPref}
          busy={busy}
          anyBusy={anyBusy}
          onClose={() => setContextMenu(null)}
          onShowProfile={() => setProfileOpen(true)}
          onSetVolume={(volume) => onSetMemberVolume?.(memberKey, volume)}
          onSetLocalMuted={(muted) => onSetMemberLocalMuted?.(memberKey, muted)}
          onManageParticipant={onManageParticipant}
        />
      )}
      {profileOpen && (
        <MemberProfileDialog
          item={item}
          memberKey={memberKey}
          channelName={currentChannel?.name}
          localPref={localPref}
          onClose={() => setProfileOpen(false)}
        />
      )}
    </article>
  );
}
export default memo(VoiceParticipantCard);
