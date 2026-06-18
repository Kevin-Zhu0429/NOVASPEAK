import OnlineMemberCard from "./OnlineMemberCard";

const STATUS_TEXT = {
  online: "在线",
  connecting: "正在连接在线列表",
  reconnecting: "在线列表正在重连",
  unavailable: "在线列表暂时不可用",
  offline: "在线列表已关闭",
};

export default function OnlineMembersPanel({ members, connectionStatus, embedded = false }) {
  return (
    <aside className={embedded ? "online-members-panel embedded" : "online-members-panel"}>
      <div className="voice-panel-title"><h3>在线成员</h3><span>{members.length}</span></div>
      <p className={`presence-connection ${connectionStatus}`}>{STATUS_TEXT[connectionStatus]}</p>
      <div className="online-member-list">
        {members.map((member) => <OnlineMemberCard key={member.presenceId} member={member} />)}
        {!members.length && connectionStatus === "online" && <p className="presence-empty">暂无在线成员</p>}
      </div>
    </aside>
  );
}
