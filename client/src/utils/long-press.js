export const LONG_PRESS_DELAY_MS = 550;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

// 长按不应从按钮、输入控件或已打开的菜单/弹窗上触发，避免拦截正常点击。
export function shouldIgnoreLongPressTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("button, input, a, select, textarea, .voice-member-menu, .member-profile-overlay"));
}

// 纯逻辑长按追踪器：touchstart 后 delayMs 触发；移动超出容差、抬手或取消都会终止。
// scheduler 可注入，便于 Node 测试。
export function createLongPressTracker({
  onLongPress,
  delayMs = LONG_PRESS_DELAY_MS,
  moveTolerancePx = LONG_PRESS_MOVE_TOLERANCE_PX,
  schedule = (fn, delay) => setTimeout(fn, delay),
  cancelSchedule = (id) => clearTimeout(id),
} = {}) {
  let timer = null;
  let origin = null;

  const cancel = () => {
    if (timer !== null) {
      cancelSchedule(timer);
      timer = null;
    }
    origin = null;
  };

  return {
    start(point) {
      cancel();
      if (!point || typeof point.x !== "number" || typeof point.y !== "number") return;
      origin = point;
      timer = schedule(() => {
        timer = null;
        const firedAt = origin;
        origin = null;
        if (firedAt && typeof onLongPress === "function") onLongPress(firedAt);
      }, delayMs);
    },
    move(point) {
      if (origin === null || !point) return;
      if (Math.abs(point.x - origin.x) > moveTolerancePx || Math.abs(point.y - origin.y) > moveTolerancePx) cancel();
    },
    cancel,
    isPending: () => timer !== null,
  };
}
