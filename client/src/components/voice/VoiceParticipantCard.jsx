import { memo, useEffect, useRef, useState } from "react";
import { Mic, MicOff, MoreHorizontal, Signal } from "lucide-react";
import { formatLoss, qualityLabel } from "../../utils/voice-network";
import { getMemberStatusBadges } from "../../utils/voice-member-menu";
import { getMemberAudioKey, getMemberAudioPref } from "../../utils/local-audio-preferences";
import { createLongPressTracker, shouldIgnoreLongPressTarget } from "../../utils/long-press";
import { resolveParticipantAvatarUrl } from "../../utils/avatar";
import VoiceMemberContextMenu from "./VoiceMemberContextMenu";
import MemberProfileDialog from "./MemberProfileDialog";
import UserAvatar from "../common/UserAvatar";

function VoiceParticipantCard({ item, receiveLoss, onlineMembers, currentUser, currentChannel, channels, busy, anyBusy, onManageParticipant, localAudioPrefs, onSetMemberVolume, onSetMemberLocalMuted }) {
  const [contextMenu, setContextMenu] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const buttonRef = useRef(null);
  const memberKey = getMemberAudioKey(item);
  const localPref = getMemberAudioPref(localAudioPrefs, memberKey);
  const statusBadges = getMemberStatusBadges({ serverMuted: item.serverMuted, localMuted: !item.isLocal && localPref.muted });
  // LiveKit metadata 不含头像：本人用 currentUser，其余成员用 Presence 在线数据
  const avatarUrl = resolveParticipantAvatarUrl({ isLocal: item.isLocal, displayName: item.displayName, currentUser, onlineMembers });

  // 手机端补充入口：长按卡片 550ms 打开菜单（不影响滚动和按钮点击）
  const [longPress] = useState(() => createLongPressTracker({ onLongPress: (point) => setContextMenu({ x: point.x, y: point.y }) }));
  useEffect(() => () => longPress.cancel(), [longPress]);

  const openContextMenu = (event) => {
    event.preventDefault();
    // Portal 内的右键事件会沿 React 树冒泡回卡片，不重新打开菜单
    if (event.target instanceof Element && event.target.closest(".voice-member-menu, .member-profile-overlay")) return;
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  // ⋯ 按钮在所有端打开同一个完整成员菜单，再次点击关闭
  const toggleMenuFromButton = () => {
    setContextMenu((previous) => {
      if (previous) return null;
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return { x: rect.left, y: rect.bottom + 6 };
    });
  };

  const onTouchStart = (event) => {
    if (event.touches.length !== 1 || shouldIgnoreLongPressTarget(event.target)) {
      longPress.cancel();
      return;
    }
    const touch = event.touches[0];
    longPress.start({ x: touch.clientX, y: touch.clientY });
  };
  const onTouchMove = (event) => {
    const touch = event.touches[0];
    if (touch) longPress.move({ x: touch.clientX, y: touch.clientY });
  };

  return (
    <article
      className={`voice-participant-card ${item.isSpeaking ? "speaking" : ""} ${busy ? "operating" : ""}`}
      onContextMenu={openContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={() => longPress.cancel()}
      onTouchCancel={() => longPress.cancel()}
    >
      <UserAvatar avatarUrl={avatarUrl} displayName={item.displayName} size="md" status={item.isSpeaking ? "speaking" : ""} />
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
      <div className="voice-member-actions">
        <button ref={buttonRef} type="button" className="voice-member-menu-button" onClick={toggleMenuFromButton} disabled={busy || anyBusy} aria-label="成员菜单" aria-haspopup="menu" aria-expanded={Boolean(contextMenu)}>
          <MoreHorizontal size={17} />
        </button>
      </div>
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
          anchorRef={buttonRef}
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
          avatarUrl={avatarUrl}
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
