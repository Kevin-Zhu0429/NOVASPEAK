export const FORMAL_ROLES = Object.freeze(["admin", "member", "user"]);
export const ALL_ROLES = Object.freeze([...FORMAL_ROLES, "guest"]);

const MOVE_TARGETS = Object.freeze({
  admin: new Set(ALL_ROLES),
  member: new Set(["member", "user", "guest"]),
  user: new Set(["user", "guest"]),
  guest: new Set(),
});

const REMOVE_TARGETS = Object.freeze({
  admin: new Set(ALL_ROLES),
  member: new Set(["member", "user", "guest"]),
  user: new Set(),
  guest: new Set(),
});

export function isFormalRole(role) {
  return FORMAL_ROLES.includes(role);
}

export function getRoleLabel(role) {
  if (role === "admin") return "管理员";
  if (role === "member") return "战队成员";
  if (role === "user") return "普通语音用户";
  if (role === "guest") return "访客";
  return "身份未知";
}

export function canManageChannels(role) {
  return role === "admin" || role === "member";
}

export function canControlMusic(role) {
  return isFormalRole(role);
}

export function canClearMusicQueue(role) {
  return role === "admin";
}

export function canMoveRole(actorRole, targetRole) {
  return MOVE_TARGETS[actorRole]?.has(targetRole) === true;
}

export function canRemoveRole(actorRole, targetRole) {
  return REMOVE_TARGETS[actorRole]?.has(targetRole) === true;
}

export function canServerMute(role) {
  return role === "admin";
}
