export default function AudioDevicePanel({ devices, inputId, outputId, onInput, onOutput, busy }) {
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
      {devices.error && <small className="device-error">{devices.error}</small>}
    </div>
  );
}
