import { useState } from "react";
import OnlineMemberCard from "./OnlineMemberCard";
import useTransientMessage from "../../hooks/useTransientMessage";
import { kickOnlineMember, moveOnlineMember } from "../../utils/presence-management-api";

const STATUS_TEXT = {
  online: "在线",
  connecting: "正在连接在线列表",
  reconnecting: "在线列表正在重连",
  unavailable: "在线列表暂时不可用",
  offline: "在线列表已关闭",
};

export default function OnlineMembersPanel({ members, connectionStatus, embedded = false, currentUser, channels = [], apiBase = "" }) {
  const [busyPresenceId, setBusyPresenceId] = useState("");
  const [notice, setNotice] = useTransientMessage();
  const [error, setError] = useState("");

  const run = async (member, operation) => {
    if (!member?.presenceId || busyPresenceId) return;
    setBusyPresenceId(member.presenceId);
    setNotice("");
    setError("");
    try {
      const result = await operation();
      setNotice(result.message || "操作成功");
    } catch (operationError) {
      setError(operationError?.message || "在线成员操作失败");
    } finally {
      setBusyPresenceId("");
    }
  };

  const handleKick = (member) => {
    if (!window.confirm(`确认将“${member.nickname}”踢出服务器吗？`)) return;
    void run(member, () => kickOnlineMember(apiBase, member.presenceId));
  };

  return (
    <aside className={embedded ? "online-members-panel embedded" : "online-members-panel"}>
      <div className="voice-panel-title"><h3>在线成员</h3><span>{members.length}</span></div>
      <p className={`presence-connection ${connectionStatus}`}>{STATUS_TEXT[connectionStatus]}</p>
      {notice && <p className="online-member-notice">{notice}</p>}
      {error && <p className="online-member-error">{error}</p>}
      <div className="online-member-list">
        {members.map((member) => (
          <OnlineMemberCard
            key={member.presenceId}
            member={member}
            currentUser={currentUser}
            channels={channels}
            busy={busyPresenceId === member.presenceId}
            onMove={(target, channelId) => void run(target, () => moveOnlineMember(apiBase, target.presenceId, channelId))}
            onKick={handleKick}
          />
        ))}
        {!members.length && connectionStatus === "online" && <p className="presence-empty">暂无在线成员</p>}
      </div>
    </aside>
  );
}
