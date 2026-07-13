import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMicConstraintsToRoom,
  loadMicConstraints,
  sameMicConstraints,
  saveMicConstraints,
  setMicConstraint,
} from "../utils/microphone-constraints";

// 当前用户的麦克风降噪约束（回声消除 / 噪声抑制 / 自动增益），只存 localStorage，只影响本机。
// 通话中切换时原地重启本地麦克风轨道套用新约束；不触碰服务器静音 / 本地静音 / 麦克风开关。
export default function useMicrophoneConstraints(room) {
  const [constraints, setConstraints] = useState(() => loadMicConstraints());
  const [applyError, setApplyError] = useState("");
  const appliedRef = useRef(null);
  const queueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!room) {
      appliedRef.current = null;
      setApplyError("");
      return;
    }
    const previous = appliedRef.current;
    appliedRef.current = { room, constraints };
    // 新房间构造时已通过 audioCaptureDefaults 带上当前约束，只有同一房间内真正变化才重启音轨；
    // 连续切换通过 promise 队列串行应用，避免两次 restart 交叉。
    if (!previous || previous.room !== room || sameMicConstraints(previous.constraints, constraints)) return;
    let stale = false;
    queueRef.current = queueRef.current
      .then(() => applyMicConstraintsToRoom(room, constraints))
      .then((result) => {
        if (stale) return;
        if (result.status === "failed") {
          console.error("应用麦克风降噪设置失败：", result.error);
          setApplyError("无法应用麦克风降噪设置，请重试或重新进入频道");
        } else {
          setApplyError("");
        }
      });
    return () => { stale = true; };
  }, [room, constraints]);

  const toggleConstraint = useCallback((key, enabled) => {
    setConstraints((previous) => {
      const next = setMicConstraint(previous, key, enabled);
      saveMicConstraints(next);
      return next;
    });
  }, []);

  return { constraints, toggleConstraint, applyError };
}
