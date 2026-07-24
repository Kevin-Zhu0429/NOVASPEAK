export function getPositionText(user, fallback = "队员") {
  if (user?.isGuest || user?.role === "guest") {
    return "访客";
  }
  if (user?.role === "user") {
    return "普通语音用户";
  }

  if (
    Array.isArray(user?.positionNames) &&
    user.positionNames.length > 0
  ) {
    return user.positionNames.join(" · ");
  }

  return user?.positionName || fallback;
}
