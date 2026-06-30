import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import ChannelEditForm from "./ChannelEditForm";
import DeleteChannelDialog from "./DeleteChannelDialog";
import {
  buildReorderedChannelIds,
  canDeleteChannel,
  canMoveChannelDown,
  canMoveChannelUp,
  extractApiError,
  getAccessLevelLabel,
  sortChannels,
} from "../../utils/channel-settings";

export default function ChannelManagementPanel({ channels, apiBase = "", onClose, onRefreshChannels, onInvalidateChannels }) {
  const [editingId, setEditingId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const sortedChannels = useMemo(() => sortChannels(channels), [channels]);
  const editingChannel = sortedChannels.find((channel) => channel.id === editingId) || null;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  function setSafeMessage(value, fallback = "") {
    setMessage(typeof value === "string" ? value : fallback);
  }

  function setSafeError(value, fallback = "") {
    setError(value instanceof Error ? value.message : typeof value === "string" ? value : fallback);
  }

  async function patchChannel(channelId, payload, fallback) {
    const response = await fetch(`${apiBase}/api/channels/${encodeURIComponent(channelId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await extractApiError(response, fallback));
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) throw new Error(fallback);
    return response.json();
  }

  async function saveChannel(payload) {
    if (!editingChannel) return;
    onInvalidateChannels?.();
    setBusy(true);
    setSafeMessage("正在保存…");
    setError("");
    try {
      await patchChannel(editingChannel.id, payload, "修改频道失败");
      setSafeMessage("频道设置已保存");
      setEditingId(null);
      await onRefreshChannels();
    } catch (requestError) {
      setMessage("");
      setSafeError(requestError, "修改频道失败");
    } finally {
      setBusy(false);
    }
  }

  async function moveChannel(index, direction) {
    const result = buildReorderedChannelIds(sortedChannels, index, direction);
    if (result.error) return;
    const current = sortedChannels[index];
    const adjacent = sortedChannels[direction === "up" ? index - 1 : index + 1];
    console.info("[channel-reorder] request", { channelId: current?.id, sortOrder: current?.sortOrder, adjacentChannelId: adjacent?.id, adjacentSortOrder: adjacent?.sortOrder });
    onInvalidateChannels?.();
    setBusy(true);
    setSafeMessage("正在调整排序…");
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/channels/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelIds: result.channelIds }),
      });
      if (!response.ok) throw new Error(await extractApiError(response, "调整频道排序失败"));
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("调整频道排序失败");
      const data = await response.json();
      setSafeMessage("频道排序已更新");
      if (Array.isArray(data.channels)) await onRefreshChannels(data.channels);
      else await onRefreshChannels();
    } catch (requestError) {
      setMessage("");
      setSafeError(requestError, "调整频道排序失败");
      await onRefreshChannels();
    } finally {
      setBusy(false);
    }
  }

  async function deleteChannel() {
    if (!pendingDelete) return;
    onInvalidateChannels?.();
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/channels/${encodeURIComponent(pendingDelete.id)}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) {
        let apiError = await extractApiError(response, "删除频道失败");
        if (response.status === 409 && apiError.includes("仍有成员")) apiError = "频道内仍有成员，无法删除";
        if (apiError.includes("系统默认频道")) apiError = "系统默认频道不能删除";
        throw new Error(apiError);
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) throw new Error("删除频道失败");
      setPendingDelete(null);
      setSafeMessage("频道已删除");
      await onRefreshChannels();
    } catch (requestError) {
      setSafeError(requestError, "删除频道失败");
    } finally {
      setBusy(false);
    }
  }

  const panel = (
    <div className="channel-management-overlay" role="dialog" aria-modal="true" aria-label="频道管理">
      <section className="channel-management-panel">
        <header>
          <div><span>NovaSpeak Admin</span><h2>频道管理</h2><p>编辑频道名称、描述、排序、人数上限和进入权限。</p></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭频道管理">×</button>
        </header>
        {message && <p className="channel-panel-message success">{message}</p>}
        {error && <p className="channel-panel-message error">{error}</p>}
        <div className="channel-settings-list">
          {sortedChannels.map((channel, index) => (
            <article className="channel-settings-card" key={channel.id}>
              <div className="channel-settings-main">
                <div><h3>{channel.name}</h3><p>{channel.description || "暂无频道描述"}</p><small>ID：{channel.id}</small></div>
                <span className={channel.isSystem ? "channel-type system" : "channel-type"}>{channel.isSystem ? "系统频道" : "普通频道"}</span>
              </div>
              <div className="channel-settings-meta">
                <span>排序：{channel.sortOrder}</span><span>人数：{channel.participantCount ?? 0}{channel.maxMembers ? ` / ${channel.maxMembers}` : " / 不限制"}</span><span>权限：{getAccessLevelLabel(channel.accessLevel)}</span><span>{channel.allowGuests && channel.accessLevel === "everyone" ? "允许 Guest" : "Guest 禁止"}</span>
              </div>
              <div className="channel-settings-actions">
                <button type="button" onClick={() => moveChannel(index, "up")} disabled={busy || !canMoveChannelUp(sortedChannels, index)}>上移</button>
                <button type="button" onClick={() => moveChannel(index, "down")} disabled={busy || !canMoveChannelDown(sortedChannels, index)}>下移</button>
                <button type="button" onClick={() => setEditingId(channel.id)} disabled={busy}>编辑</button>
                {canDeleteChannel(channel) ? <button type="button" className="danger-button" onClick={() => setPendingDelete(channel)} disabled={busy}>删除频道</button> : <span className="channel-system-note">系统大厅不能删除</span>}
              </div>
              {editingChannel?.id === channel.id && <ChannelEditForm channel={editingChannel} saving={busy} onCancel={() => setEditingId(null)} onSave={saveChannel} />}
            </article>
          ))}
        </div>
      </section>
      <DeleteChannelDialog channel={pendingDelete} deleting={busy} onCancel={() => setPendingDelete(null)} onConfirm={deleteChannel} />
    </div>
  );

  return createPortal(panel, document.body);
}
