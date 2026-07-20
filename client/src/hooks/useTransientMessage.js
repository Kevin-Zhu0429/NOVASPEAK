import { useCallback, useEffect, useRef, useState } from "react";

export const DEFAULT_TRANSIENT_MESSAGE_DURATION_MS = 5_000;

// 用于操作成功、被移动等短暂反馈。重复写入同一条文案时也会重新计时，
// 组件卸载时会清理计时器，避免旧页面稍后修改新页面状态。
export default function useTransientMessage(
  durationMs = DEFAULT_TRANSIENT_MESSAGE_DURATION_MS
) {
  const [message, setMessage] = useState("");
  const timeoutRef = useRef(null);
  const safeDurationMs = Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : DEFAULT_TRANSIENT_MESSAGE_DURATION_MS;

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const showMessage = useCallback((nextMessage) => {
    const normalized = typeof nextMessage === "string" ? nextMessage : "";
    clearTimer();
    setMessage(normalized);
    if (!normalized) return;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setMessage("");
    }, safeDurationMs);
  }, [clearTimer, safeDurationMs]);

  useEffect(() => clearTimer, [clearTimer]);

  return [message, showMessage];
}
