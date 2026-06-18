const LABELS = {
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  restored: "连接已恢复",
  failed: "连接失败",
  disconnected: "已断开",
};

export default function ConnectionStatus({ status, error, audioBlocked, onEnableAudio, onReconnect, onLeave }) {
  return (
    <div className="voice-status-stack" aria-live="polite">
      <div className={`connection-status ${status}`}><span />{LABELS[status] || "连接状态未知"}</div>
      {error && <div className="voice-alert error">{error}</div>}
      {audioBlocked && (
        <button type="button" className="voice-alert action" onClick={onEnableAudio}>
          音频播放被浏览器阻止，请点击启用
        </button>
      )}
      {status === "failed" && (
        <div className="connection-recovery-actions">
          <button type="button" onClick={onReconnect}>重新连接</button>
          <button type="button" className="danger" onClick={onLeave}>退出频道</button>
        </div>
      )}
    </div>
  );
}
