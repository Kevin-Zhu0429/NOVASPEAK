export default function DeleteChannelDialog({ channel, deleting, onCancel, onConfirm }) {
  if (!channel) return null;
  return (
    <div className="channel-delete-backdrop" role="presentation">
      <div className="channel-delete-dialog" role="dialog" aria-modal="true" aria-label="删除频道确认">
        <h3>删除频道</h3>
        <p>确定删除频道“{channel.name}”吗？</p>
        <span>频道内有成员时无法删除。</span>
        <div>
          <button type="button" onClick={onCancel} disabled={deleting}>取消</button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={deleting}>{deleting ? "正在删除…" : "确认删除"}</button>
        </div>
      </div>
    </div>
  );
}
