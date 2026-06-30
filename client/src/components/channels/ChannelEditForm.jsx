import { useEffect, useRef, useState } from "react";
import {
  buildChannelPatchPayload,
  canToggleGuests,
  getChannelFormInitialValues,
} from "../../utils/channel-settings";

export default function ChannelEditForm({ channel, onCancel, onSave, saving }) {
  const [form, setForm] = useState(() => getChannelFormInitialValues(channel));
  const [error, setError] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const editingChannelIdRef = useRef(channel?.id || null);

  useEffect(() => {
    const nextChannelId = channel?.id || null;
    if (editingChannelIdRef.current !== nextChannelId) {
      editingChannelIdRef.current = nextChannelId;
      setForm(getChannelFormInitialValues(channel));
      setError("");
      setIsDirty(false);
    }
  }, [channel]);

  function updateField(name, value) {
    setIsDirty(true);
    setForm((current) => {
      const next = { ...current, [name]: value };
      if (name === "accessLevel" && value !== "everyone") next.allowGuests = false;
      return next;
    });
  }

  async function submit(event) {
    event.preventDefault();
    const result = buildChannelPatchPayload(form);
    if (result.error) {
      setError(result.error);
      return;
    }
    setError("");
    await onSave(result.payload);
  }

  const guestEnabled = canToggleGuests(form.accessLevel);
  const descriptionLength = form.description.length;

  return (
    <form className="channel-edit-form" onSubmit={submit}>
      <div className="channel-form-grid">
        <label>
          <span>频道名称</span>
          <input value={form.name} onChange={(event) => updateField("name", event.target.value)} maxLength={40} disabled={saving} />
        </label>

        <label>
          <span>频道描述</span>
          <textarea value={form.description} onChange={(event) => updateField("description", event.target.value)} maxLength={200} disabled={saving} />
          <small>{descriptionLength}/200</small>
        </label>

        <div className="channel-radio-row">
          <span>人数上限</span>
          <label><input type="radio" name="maxMembersMode" checked={form.maxMembersMode === "unlimited"} onChange={() => updateField("maxMembersMode", "unlimited")} disabled={saving} /> 不限制</label>
          <label><input type="radio" name="maxMembersMode" checked={form.maxMembersMode === "limited"} onChange={() => updateField("maxMembersMode", "limited")} disabled={saving} /> 限制人数</label>
          {form.maxMembersMode === "limited" && <input type="number" min="1" max="99" value={form.maxMembers} onChange={(event) => updateField("maxMembers", event.target.value)} disabled={saving} />}
        </div>

        <label>
          <span>进入权限</span>
          <select value={form.accessLevel} onChange={(event) => updateField("accessLevel", event.target.value)} disabled={saving}>
            <option value="everyone">所有正式成员及允许的访客</option>
            <option value="members">仅正式战队成员</option>
            <option value="admins">仅管理员</option>
          </select>
        </label>

        <label className="channel-switch-row">
          <input type="checkbox" checked={form.allowGuests} onChange={(event) => updateField("allowGuests", event.target.checked)} disabled={saving || !guestEnabled} />
          <span>允许访客进入</span>
        </label>
        {!guestEnabled && <p className="channel-form-hint">当前权限下 Guest 默认禁止进入，提交时会保存为禁止访客。</p>}
      </div>

      {error && <p className="channel-panel-message error">{error}</p>}

      <div className="channel-form-actions">
        <button type="button" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-action" disabled={saving}>{saving ? "正在保存…" : "保存设置"}</button>
      </div>
    </form>
  );
}
