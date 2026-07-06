import { useEffect } from "react";
import { createPortal } from "react-dom";
import { getRoleLabel, getParticipantStatusLabels } from "../../utils/voice-member-menu";

export default function VoiceParticipantProfileModal({ item, channel, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!item) return null;
  const statuses = getParticipantStatusLabels(item);
  const positions = Array.isArray(item.positionNames) && item.positionNames.length > 0 ? item.positionNames.join(" · ") : (item.positionText && item.positionText !== "访客" ? item.positionText : "未设置");
  return createPortal(
    <div className="voice-profile-overlay" role="dialog" aria-modal="true" aria-label="成员资料">
      <section className="voice-profile-modal">
        <header><div><span>MEMBER PROFILE</span><h3>成员资料</h3></div><button type="button" onClick={onClose} aria-label="关闭成员资料">×</button></header>
        <dl>
          <div><dt>昵称</dt><dd>{item.displayName}{item.isLocal ? "（我）" : ""}</dd></div>
          <div><dt>成员 ID</dt><dd>{item.publicMemberId || item.memberKey || item.id}</dd></div>
          <div><dt>身份</dt><dd>{getRoleLabel(item.role)}</dd></div>
          <div><dt>职位</dt><dd>{positions}</dd></div>
          <div><dt>当前频道状态</dt><dd>{channel?.name || "当前语音频道"}</dd></div>
          <div><dt>服务器静音状态</dt><dd>{statuses.serverMuted}</dd></div>
          <div><dt>本地静音状态</dt><dd>{item.isLocal ? "不适用于自己" : statuses.localMuted}</dd></div>
          <div><dt>本地音量</dt><dd>{item.isLocal ? "不适用于自己" : `${item.localVolume ?? 100}%`}</dd></div>
        </dl>
      </section>
    </div>,
    document.body,
  );
}
