import { memo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { getPresenceDeviceText, getPresenceLocationText, getPresencePositionText } from "../../utils/presence-display";
import UserAvatar from "../common/UserAvatar";
import OnlineMemberContextMenu from "./OnlineMemberContextMenu";

function OnlineMemberCard({ member, currentUser, channels, busy, onMove, onKick }) {
  const [contextMenu, setContextMenu] = useState(null);
  const buttonRef = useRef(null);
  const deviceText = getPresenceDeviceText(member);
  const canManage = !member.isCurrentUser && ["admin", "member"].includes(currentUser?.role);
  const openMenu = (event) => {
    if (!canManage) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };
  const toggleMenu = () => {
    setContextMenu((current) => {
      if (current) return null;
      const rect = buttonRef.current?.getBoundingClientRect();
      return rect ? { x: rect.left, y: rect.bottom + 6 } : null;
    });
  };
  return (
    <article className={`online-member-card ${member.state} ${busy ? "operating" : ""}`} onContextMenu={openMenu}>
      <UserAvatar avatarUrl={member.avatarUrl} displayName={member.nickname} size="list" status="online" />
      <div className="online-member-copy">
        <strong>{member.nickname}{member.isCurrentUser ? "（我）" : ""}</strong>
        <span>{getPresencePositionText(member)}</span>
        <small><i />{getPresenceLocationText(member)}</small>
        {deviceText && <em>{deviceText}</em>}
      </div>
      {canManage && (
        <button ref={buttonRef} type="button" className="online-member-menu-button" onClick={toggleMenu} disabled={busy} aria-label={`${member.nickname}的管理菜单`}>
          <MoreHorizontal size={16} />
        </button>
      )}
      {contextMenu && (
        <OnlineMemberContextMenu
          position={contextMenu}
          member={member}
          currentUser={currentUser}
          channels={channels}
          busy={busy}
          anchorRef={buttonRef}
          onClose={() => setContextMenu(null)}
          onMove={(channelId) => onMove(member, channelId)}
          onKick={() => onKick(member)}
        />
      )}
    </article>
  );
}
export default memo(OnlineMemberCard);
