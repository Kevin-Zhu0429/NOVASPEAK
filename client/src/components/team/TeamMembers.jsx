import { useEffect, useState } from "react";
import { getPositionText } from "../../utils/user-display";
import UserAvatar from "../common/UserAvatar";
import { getRoleLabel } from "../../utils/roles";

const API_BASE = import.meta.env.VITE_API_BASE || "";

export default function TeamMembers({ onClose }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadMembers() {
      try {
        const response = await fetch(`${API_BASE}/api/team/public-members`, {
          credentials: "include",
        });
        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("application/json")) {
          const responseText = await response.text();
          console.error("战队成员接口返回了非 JSON 内容：", responseText);
          throw new Error("战队成员接口未正确连接到后端");
        }

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "获取战队成员失败");
        }

        if (!cancelled) {
          setMembers(data.members || []);
        }
      } catch (requestError) {
        console.error("Load public members error:", requestError);
        if (!cancelled) {
          setError(requestError.message || "获取战队成员失败");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadMembers();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="team-management-overlay" role="dialog" aria-modal="true">
      <div className="team-members-modal">
        <header className="management-header">
          <div>
            <div className="management-label">NOVA GAMING</div>
            <h2>战队成员</h2>
            <p>查看正式成员与战队职位</p>
          </div>
          <button
            type="button"
            className="management-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="team-members-content">
          {loading ? (
            <div className="management-empty">正在加载成员...</div>
          ) : error ? (
            <div className="account-message error">{error}</div>
          ) : (
            <div className="management-member-list">
              {members.map((member) => (
                <div className="management-member" key={member.id}>
                  <UserAvatar
                    avatarUrl={member.avatarUrl}
                    displayName={member.displayName}
                    size="md"
                  />
                  <div className="member-information">
                    <strong>{member.displayName}</strong>
                    <span>
                      {member.role === "user"
                        ? "普通语音用户"
                        : getPositionText(member)}
                    </span>
                  </div>
                  <div className={member.role === "admin" ? "member-role captain" : "member-role"}>
                    {getRoleLabel(member.role)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
