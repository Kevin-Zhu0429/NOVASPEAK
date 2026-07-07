import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getMemberContextMenuModel } from "../../utils/voice-member-menu";
import { MAX_MEMBER_VOLUME, MIN_MEMBER_VOLUME } from "../../utils/local-audio-preferences";

export default function VoiceMemberContextMenu({ position, item, currentUser, currentChannel, channels = [], localPref, busy, anyBusy, onClose, onShowProfile, onSetVolume, onSetLocalMuted, onManageParticipant }) {
  const menuRef = useRef(null);
  const [style, setStyle] = useState({ top: position.y, left: position.x, visibility: "hidden" });
  const [moveOpen, setMoveOpen] = useState(false);
  const model = getMemberContextMenuModel({ item, currentUser, currentChannel, channels, localPref });
  const targetChannels = channels.filter((channel) => channel.id !== currentChannel?.id);
  const showServerMute = model.managementActions.includes("mute") || model.managementActions.includes("unmute");
  const showMove = model.managementActions.includes("move");
  const showRemove = model.managementActions.includes("remove");
  const managementDisabled = busy || anyBusy;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 10;
    const rect = menu.getBoundingClientRect();
    let left = position.x;
    let top = position.y;
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, window.innerHeight - rect.height - margin);
    setStyle({ top, left, visibility: "visible" });
  }, [position.x, position.y, moveOpen, targetChannels.length]);

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    const onMouseDown = (event) => { if (!menuRef.current?.contains(event.target)) onClose(); };
    const onScroll = (event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const runManagement = (action, targetChannelId) => {
    onClose();
    onManageParticipant?.(action, item, targetChannelId);
  };

  const menu = (
    <div
      className="voice-member-menu voice-member-menu-portal voice-member-context-menu"
      ref={menuRef}
      style={style}
      onContextMenu={(event) => event.preventDefault()}
    >
      {model.showProfile && (
        <button type="button" onClick={() => { onClose(); onShowProfile?.(); }}>查看成员资料</button>
      )}
      {model.showLocalControls && (
        <>
          <div className="voice-menu-divider" />
          <button type="button" onClick={() => onSetLocalMuted?.(!(localPref?.muted === true))}>
            {model.localMuteAction === "local-unmute" ? "取消本地静音" : "本地静音"}
          </button>
        </>
      )}
      {model.showVolumeSlider && (
        <div className="voice-volume-control">
          <span>音量：{localPref?.volume ?? 100}%</span>
          <input
            type="range"
            min={MIN_MEMBER_VOLUME}
            max={MAX_MEMBER_VOLUME}
            step={1}
            value={localPref?.volume ?? 100}
            onChange={(event) => onSetVolume?.(Number(event.target.value))}
            aria-label="成员本地音量"
          />
          {(localPref?.volume ?? 100) > 100 && (
            <small>浏览器原生音量最高为 100%，更高增益后续再支持</small>
          )}
        </div>
      )}
      {model.managementActions.length > 0 && <div className="voice-menu-divider" />}
      {showServerMute && (
        <button type="button" disabled={managementDisabled} onClick={() => runManagement(item.serverMuted ? "unmute" : "mute")}>
          {item.serverMuted ? "解除服务器静音" : "服务器静音"}
        </button>
      )}
      {showMove && (
        <>
          <button type="button" disabled={managementDisabled} onClick={() => setMoveOpen((value) => !value)}>移动到其他频道</button>
          {moveOpen && (
            <div className="voice-channel-submenu">
              {targetChannels.map((channel) => (
                <button key={channel.id} type="button" disabled={managementDisabled} onClick={() => runManagement("move", channel.id)}>{channel.name}</button>
              ))}
              {targetChannels.length === 0 && <span>没有可移动的频道</span>}
            </div>
          )}
        </>
      )}
      {showRemove && (
        <button type="button" disabled={managementDisabled} onClick={() => runManagement("remove")}>移出当前频道</button>
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
