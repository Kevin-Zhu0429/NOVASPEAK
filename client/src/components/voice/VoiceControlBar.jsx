import { Headphones, HeadphoneOff, LogOut, Mic, MicOff, Settings2 } from "lucide-react";

export default function VoiceControlBar({ microphoneEnabled, deafen, busy, disabled, devicesOpen, onMicrophone, onDeafen, onDevices, onLeave }) {
  return (
    <div className="voice-control-bar">
      <button type="button" className={!microphoneEnabled ? "active-off" : ""} onClick={onMicrophone} disabled={busy || disabled || deafen}>
        {microphoneEnabled ? <Mic /> : <MicOff />}<span>{busy ? "处理中" : microphoneEnabled ? "麦克风开启" : "麦克风关闭"}</span>
      </button>
      <button type="button" className={deafen ? "active-off" : ""} onClick={onDeafen} disabled={busy || disabled}>
        {deafen ? <HeadphoneOff /> : <Headphones />}<span>{deafen ? "耳机已静音" : "耳机静音"}</span>
      </button>
      <button type="button" className={devicesOpen ? "selected" : ""} onClick={onDevices} disabled={disabled}>
        <Settings2 /><span>音频设备</span>
      </button>
      <button type="button" className="leave-voice" onClick={onLeave}><LogOut /><span>退出频道</span></button>
    </div>
  );
}
