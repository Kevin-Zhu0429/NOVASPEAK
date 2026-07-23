import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getUserManagementCapabilities } from "../../utils/roles";

export default function OnlineMemberContextMenu({
  position,
  member,
  currentUser,
  channels = [],
  busy = false,
  anchorRef,
  onClose,
  onMove,
  onKick,
}) {
  const menuRef = useRef(null);
  const [style, setStyle] = useState({ top: position.y, left: position.x, visibility: "hidden" });
  const [moveOpen, setMoveOpen] = useState(false);
  const targetChannels = channels.filter((channel) => channel?.id && channel.id !== member.channelId);
  const capabilities = getUserManagementCapabilities(currentUser?.role, member.role);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 10;
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const left = Math.min(Math.max(margin, position.x), maxLeft);
    const top = Math.min(Math.max(margin, position.y), maxTop);
    setStyle({ top, left, visibility: "visible" });
  }, [position.x, position.y, moveOpen, targetChannels.length]);

  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    const closeOutside = (event) => {
      if (menuRef.current?.contains(event.target) || anchorRef?.current?.contains(event.target)) return;
      onClose();
    };
    const closeOnResize = () => onClose();
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className="voice-member-menu voice-member-menu-portal online-member-context-menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {capabilities.canMove && (
        <button type="button" disabled={busy} onClick={() => setMoveOpen((value) => !value)}>
          移动到频道
        </button>
      )}
      {capabilities.canMove && moveOpen && (
        <div className="voice-channel-submenu">
          {targetChannels.map((channel) => (
            <button key={channel.id} type="button" disabled={busy} onClick={() => { onClose(); onMove(channel.id); }}>
              {channel.name}
            </button>
          ))}
          {!targetChannels.length && <span>没有可移动的频道</span>}
        </div>
      )}
      {capabilities.canRemove && <div className="voice-menu-divider" />}
      {capabilities.canRemove && (
        <button type="button" className="danger" disabled={busy} onClick={() => { onClose(); onKick(); }}>
          踢出服务器
        </button>
      )}
    </div>,
    document.body
  );
}
