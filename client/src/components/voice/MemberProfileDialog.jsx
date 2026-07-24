import { useEffect } from "react";
import { createPortal } from "react-dom";
import UserAvatar from "../common/UserAvatar";

const ROLE_LABELS = {
  admin: "管理员",
  member: "战队成员",
  user: "普通语音用户",
  guest: "访客",
};

export default function MemberProfileDialog({ item, avatarUrl, memberKey, channelName, localPref, onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const roleText = ROLE_LABELS[item.role] || "身份未知";
  const positionText = item.role === "user"
    ? "无战队职位"
    : Array.isArray(item.positionNames) && item.positionNames.length > 0
      ? item.positionNames.join("、")
      : "未设置";
  const rows = [
    ["昵称", `${item.displayName}${item.isLocal ? "（我）" : ""}`],
    ["成员 ID", memberKey || item.id || "未知"],
    ["身份", roleText],
    ["职位", positionText],
    ["当前频道", channelName || "未知频道"],
    ["服务器静音", item.serverMuted ? "已被服务器静音" : "正常"],
    ["本地静音", item.isLocal ? "—" : localPref?.muted === true ? "已本地静音" : "未静音"],
    ["本地音量", item.isLocal ? "—" : `${localPref?.volume ?? 100}%`],
  ];

  return createPortal(
    <div className="member-profile-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="member-profile-dialog" role="dialog" aria-modal="true" aria-label="成员资料">
        <header>
          <div className="member-profile-heading">
            <UserAvatar avatarUrl={avatarUrl} displayName={item.displayName} size="lg" />
            <div>
              <span className="voice-eyebrow">MEMBER PROFILE</span>
              <h3>成员资料</h3>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭成员资料">关闭</button>
        </header>
        <dl>
          {rows.map(([label, value]) => (
            <div className="member-profile-row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body
  );
}
