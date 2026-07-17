import { MAX_VOICE_GATE_THRESHOLD_DB, MIN_VOICE_GATE_THRESHOLD_DB } from "../../utils/voice-gate";

const MIC_CONSTRAINT_ROWS = [
  { key: "echoCancellation", label: "回声消除" },
  { key: "noiseSuppression", label: "噪声抑制" },
  { key: "autoGainControl", label: "自动增益（AGC）" },
];

export default function AudioDevicePanel({ devices, inputId, outputId, onInput, onOutput, busy, micConstraints, onToggleMicConstraint, micConstraintError, voiceGate }) {
  return (
    <div className="audio-device-panel">
      <label>麦克风输入
        <select value={inputId} onChange={(event) => onInput(event.target.value)} disabled={busy || !devices.inputs.length}>
          {!devices.inputs.length && <option value="">未找到可用麦克风</option>}
          {devices.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}
        </select>
      </label>
      <label>扬声器输出
        {devices.outputSupported ? (
          <select value={outputId} onChange={(event) => onOutput(event.target.value)} disabled={busy || !devices.outputs.length}>
            {!devices.outputs.length && <option value="">未找到可用扬声器</option>}
            {devices.outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `扬声器 ${index + 1}`}</option>)}
          </select>
        ) : <span className="device-unsupported">当前浏览器不支持选择扬声器</span>}
      </label>
      <div className="mic-constraints">
        <span className="mic-constraints-title">麦克风降噪</span>
        {MIC_CONSTRAINT_ROWS.map(({ key, label }) => (
          <label key={key} className="mic-constraint-row">
            <input type="checkbox" checked={micConstraints?.[key] === true} onChange={(event) => onToggleMicConstraint?.(key, event.target.checked)} disabled={busy} />
            <span>{label}</span>
          </label>
        ))}
        <small className="mic-constraints-hint">只保存在当前浏览器；通话中切换会重新获取麦克风。自动增益默认关闭，避免放大背景音。</small>
        {micConstraintError && <small className="device-error">{micConstraintError}</small>}
      </div>
      <div className="voice-gate-settings">
        <label className="mic-constraint-row">
          <input
            type="checkbox"
            checked={voiceGate?.settings?.enabled === true}
            onChange={(event) => voiceGate?.setEnabled?.(event.target.checked)}
            disabled={busy}
          />
          <span>Voice Gate（噪声门）</span>
          {voiceGate?.settings?.enabled && (
            <strong className={voiceGate.gateOpen ? "voice-gate-open" : "voice-gate-closed"}>
              {voiceGate.gateOpen ? "传音中" : "底噪关闭"}
            </strong>
          )}
        </label>
        <label className="voice-gate-threshold">
          <span>开启阈值：{voiceGate?.settings?.thresholdDb ?? -45} dB</span>
          <input
            type="range"
            min={MIN_VOICE_GATE_THRESHOLD_DB}
            max={MAX_VOICE_GATE_THRESHOLD_DB}
            step={1}
            value={voiceGate?.settings?.thresholdDb ?? -45}
            onChange={(event) => voiceGate?.setThresholdDb?.(Number(event.target.value))}
            disabled={busy || voiceGate?.settings?.enabled !== true}
            aria-label="Voice Gate 开启阈值"
          />
        </label>
        <small className="mic-constraints-hint">数值越高，过滤风扇声越强；如果开头被截断，请把阈值往左调低。</small>
        {voiceGate?.applyError && <small className="device-error">{voiceGate.applyError}</small>}
      </div>
      {devices.error && <small className="device-error">{devices.error}</small>}
    </div>
  );
}
