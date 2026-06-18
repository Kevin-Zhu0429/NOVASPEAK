import { memo } from "react";
import { getPresenceDeviceText, getPresenceLocationText, getPresencePositionText } from "../../utils/presence-display";

function OnlineMemberCard({ member }) {
  const deviceText = getPresenceDeviceText(member);
  return (
    <article className={`online-member-card ${member.state}`}>
      <div className="voice-avatar">{member.nickname.slice(0, 1).toUpperCase()}</div>
      <div className="online-member-copy">
        <strong>{member.nickname}{member.isCurrentUser ? "（我）" : ""}</strong>
        <span>{getPresencePositionText(member)}</span>
        <small><i />{getPresenceLocationText(member)}</small>
        {deviceText && <em>{deviceText}</em>}
      </div>
    </article>
  );
}
export default memo(OnlineMemberCard);
