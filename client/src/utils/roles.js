export const FORMAL_ROLES = Object.freeze(["admin", "member", "user"]);

export function getRoleLabel(role) {
  if (role === "admin") return "管理员";
  if (role === "member") return "战队成员";
  if (role === "user") return "普通语音用户";
  if (role === "guest") return "访客";
  return "身份未知";
}

export function canMoveUserRole(actorRole, targetRole) {
  if (actorRole === "admin") return ["admin", "member", "user", "guest"].includes(targetRole);
  if (actorRole === "member") return ["member", "user", "guest"].includes(targetRole);
  if (actorRole === "user") return ["user", "guest"].includes(targetRole);
  return false;
}

export function canRemoveUserRole(actorRole, targetRole) {
  if (actorRole === "admin") return ["admin", "member", "user", "guest"].includes(targetRole);
  if (actorRole === "member") return ["member", "user", "guest"].includes(targetRole);
  return false;
}

export function getUserManagementCapabilities(actorRole, targetRole) {
  return {
    canMove: canMoveUserRole(actorRole, targetRole),
    canRemove: canRemoveUserRole(actorRole, targetRole),
    canServerMute: actorRole === "admin",
  };
}
