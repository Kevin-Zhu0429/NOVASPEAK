import { memo } from "react";
import { getPresenceDeviceText, getPresenceLocationText, getPresencePositionText } from "../../utils/presence-display";
import UserAvatar from "../common/UserAvatar";

function OnlineMemberCard({ member }) {
  const deviceText = getPresenceDeviceText(member);
  return (
    <article className={`online-member-card ${member.state}`}>
      <UserAvatar avatarUrl={member.avatarUrl} displayName={member.nickname} size="md" status="online" />
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
