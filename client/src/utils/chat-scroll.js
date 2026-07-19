export const CHAT_BOTTOM_THRESHOLD_PX = 72;

export function isNearChatBottom(
  { scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = {},
  threshold = CHAT_BOTTOM_THRESHOLD_PX
) {
  const distance = Number(scrollHeight) - Number(scrollTop) - Number(clientHeight);
  if (!Number.isFinite(distance)) return true;
  return distance <= Math.max(0, Number(threshold) || 0);
}
