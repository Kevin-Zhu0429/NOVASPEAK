import { useEffect, useState } from "react";
import { getPositionText } from "../../utils/user-display";
import UserAvatar from "../common/UserAvatar";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const POSITION_OPTIONS = [
  ["captain", "队长"], ["commander", "指挥"], ["entry", "突破手"],
  ["sniper", "狙击手"], ["support", "辅助"], ["rifler", "步枪手"],
  ["freeman", "自由人"], ["backup", "替补"], ["member", "队员"],
];

async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    console.error("战队管理接口返回了非 JSON 内容：", text);
    throw new Error("战队管理接口未正确连接到后端");
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "战队管理操作失败");
  return data;
}

export default function TeamManagement({
  currentUser,
  onClose,
  onUserUpdated,
  onMembersChanged,
}) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState({ error: "", success: "" });
  const [editingMember, setEditingMember] = useState(null);
  const [deletePending, setDeletePending] = useState(false);
  const [editForm, setEditForm] = useState({
    nickname: "", positions: [], newPassword: "", confirmPassword: "",
  });
  const [form, setForm] = useState({
    nickname: "", position: "member", password: "", confirmPassword: "",
  });

  useEffect(() => { void loadMembers(); }, []);

  async function loadMembers() {
    try {
      setLoading(true);
      const data = await requestJson("/api/team/members");
      setMembers(data.members || []);
      return data.members || [];
    } catch (error) {
      console.error("Load members error:", error);
      setMessage({ error: error.message || "获取成员列表失败", success: "" });
      return [];
    } finally {
      setLoading(false);
    }
  }

  function announceChange(member) {
    onMembersChanged?.();
    if (member?.id === currentUser?.id) onUserUpdated?.(member);
  }

  function openEditor(member) {
    setEditingMember(member);
    setDeletePending(false);
    setEditForm({
      nickname: member.displayName || member.nickname || "",
      positions: member.positions || [],
      newPassword: "",
      confirmPassword: "",
    });
    setMessage({ error: "", success: "" });
  }

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createMember(event) {
    event.preventDefault();
    if (form.password !== form.confirmPassword) {
      setMessage({ error: "两次输入的密码不一致", success: "" });
      return;
    }
    try {
      setSubmitting(true);
      setMessage({ error: "", success: "" });
      const data = await requestJson("/api/team/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname: form.nickname,
          position: form.position,
          password: form.password,
        }),
      });
      setForm({ nickname: "", position: "member", password: "", confirmPassword: "" });
      setMessage({ error: "", success: `成员 ${data.member.displayName} 创建成功` });
      announceChange(data.member);
      await loadMembers();
    } catch (error) {
      console.error("Create member error:", error);
      setMessage({ error: error.message || "创建成员失败", success: "" });
    } finally {
      setSubmitting(false);
    }
  }

  async function saveNickname(event) {
    event.preventDefault();
    await runEditRequest(`/api/admin/members/${editingMember.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: editForm.nickname }),
    }, "昵称修改成功");
  }

  async function savePositions() {
    await runEditRequest(`/api/admin/members/${editingMember.id}/positions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions: editForm.positions }),
    }, "职位修改成功");
  }

  async function resetPassword(event) {
    event.preventDefault();
    const updated = await runEditRequest(
      `/api/admin/members/${editingMember.id}/reset-password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newPassword: editForm.newPassword,
          confirmPassword: editForm.confirmPassword,
        }),
      },
      "密码已重置，目标成员需要重新登录",
      false
    );
    if (updated) {
      setEditForm((current) => ({ ...current, newPassword: "", confirmPassword: "" }));
    }
  }

  async function runEditRequest(path, options, successText, refresh = true) {
    try {
      setSubmitting(true);
      setMessage({ error: "", success: "" });
      const data = await requestJson(path, options);
      const member = data.member;
      if (member) {
        setEditingMember(member);
        setEditForm((current) => ({
          ...current,
          nickname: member.displayName,
          positions: member.positions || [],
        }));
        announceChange(member);
      }
      if (refresh) await loadMembers();
      setMessage({ error: "", success: data.message || successText });
      return true;
    } catch (error) {
      console.error("Manage member error:", error);
      setMessage({ error: error.message || "成员操作失败", success: "" });
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteMember() {
    const deleted = await runEditRequest(
      `/api/admin/members/${editingMember.id}`,
      { method: "DELETE" },
      `成员 ${editingMember.displayName} 已删除`,
      true
    );
    if (deleted) {
      announceChange();
      setEditingMember(null);
      setDeletePending(false);
    }
  }

  function togglePosition(position) {
    setEditForm((current) => ({
      ...current,
      positions: current.positions.includes(position)
        ? current.positions.filter((item) => item !== position)
        : [...current.positions, position],
    }));
  }

  return (
    <div className="team-management-overlay" role="dialog" aria-modal="true">
      <div className="team-management-modal">
        <header className="management-header">
          <div><div className="management-label">NOVA GAMING</div><h2>战队管理</h2><p>管理战队成员和登录账号</p></div>
          <button type="button" className="management-close" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="management-content">
          <section className="member-list-section">
            <div className="section-heading"><h3>战队成员</h3><span>{members.length} 人</span></div>
            {loading ? <div className="management-empty">正在加载成员...</div> : (
              <div className="management-member-list">
                {members.map((member) => (
                  <div className="management-member" key={member.id}>
                    <UserAvatar avatarUrl={member.avatarUrl} displayName={member.displayName} size="md" />
                    <div className="member-information"><strong>{member.displayName}</strong><span>{getPositionText(member)}</span></div>
                    <div className={member.role === "admin" ? "member-role captain" : "member-role"}>{member.role === "admin" ? "管理员" : "成员"}</div>
                    <button type="button" className="member-edit-button" onClick={() => openEditor(member)}>编辑</button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="create-member-section">
            <div className="section-heading"><h3>添加战队成员</h3></div>
            <form className="create-member-form" onSubmit={createMember}>
              <label><span>游戏昵称</span><input value={form.nickname} onChange={(e) => updateForm("nickname", e.target.value)} minLength={2} maxLength={24} disabled={submitting} /></label>
              <label><span>战队职位</span><select value={form.position} onChange={(e) => updateForm("position", e.target.value)} disabled={submitting}>{POSITION_OPTIONS.filter(([value]) => value !== "captain").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>初始密码</span><input type="password" value={form.password} onChange={(e) => updateForm("password", e.target.value)} minLength={8} maxLength={128} disabled={submitting} /></label>
              <label><span>确认密码</span><input type="password" value={form.confirmPassword} onChange={(e) => updateForm("confirmPassword", e.target.value)} minLength={8} maxLength={128} disabled={submitting} /></label>
              <button type="submit" className="create-member-button" disabled={submitting}>{submitting ? "正在创建..." : "创建成员账号"}</button>
            </form>
          </section>
        </div>
        {(message.error || message.success) && <div className={message.error ? "management-error management-global-message" : "management-success management-global-message"}>{message.error || message.success}</div>}
      </div>

      {editingMember && (
        <div className="member-editor-backdrop" role="presentation">
          <div className="member-editor" role="dialog" aria-modal="true" aria-label={`编辑 ${editingMember.displayName}`}>
            <header><div><span>编辑正式成员</span><h3>{editingMember.displayName}</h3><p>{editingMember.role === "admin" ? "管理员" : "成员"} · {getPositionText(editingMember)}</p></div><button type="button" onClick={() => setEditingMember(null)} aria-label="关闭编辑">×</button></header>
            <form className="editor-section" onSubmit={saveNickname}><h4>修改昵称</h4><label><span>新游戏昵称</span><input value={editForm.nickname} onChange={(e) => setEditForm((current) => ({ ...current, nickname: e.target.value }))} minLength={2} maxLength={24} disabled={submitting} /></label><button type="submit" disabled={submitting}>保存昵称</button></form>
            <section className="editor-section"><h4>修改职位</h4><p>职位只用于展示，不会改变账号权限。</p><div className="position-options">{POSITION_OPTIONS.map(([value, label]) => { const selected = editForm.positions.includes(value); return <button type="button" key={value} className={selected ? "position-option selected" : "position-option"} onClick={() => togglePosition(value)} disabled={submitting}>{selected ? "✓ " : ""}{label}</button>; })}</div><button type="button" onClick={savePositions} disabled={submitting}>保存职位</button></section>
            {editingMember.id !== currentUser?.id && <form className="editor-section" onSubmit={resetPassword}><h4>重置密码</h4><p>重置后，该成员的现有登录会话会立即失效。</p><label><span>新密码</span><input type="password" value={editForm.newPassword} onChange={(e) => setEditForm((current) => ({ ...current, newPassword: e.target.value }))} minLength={8} maxLength={128} disabled={submitting} /></label><label><span>确认新密码</span><input type="password" value={editForm.confirmPassword} onChange={(e) => setEditForm((current) => ({ ...current, confirmPassword: e.target.value }))} minLength={8} maxLength={128} disabled={submitting} /></label><button type="submit" disabled={submitting}>重置密码</button></form>}
            <section className="editor-section danger-zone"><h4>删除账号</h4>{editingMember.id === currentUser?.id ? <p>当前管理员不能在战队管理中删除自己。</p> : deletePending ? <div className="delete-confirm"><p>确定永久删除成员“{editingMember.displayName}”吗？此操作无法撤销。</p><button type="button" className="danger-button" onClick={deleteMember} disabled={submitting}>确认删除</button><button type="button" onClick={() => setDeletePending(false)} disabled={submitting}>取消</button></div> : <button type="button" className="danger-button" onClick={() => setDeletePending(true)}>删除成员账号</button>}</section>
          </div>
        </div>
      )}
    </div>
  );
}
