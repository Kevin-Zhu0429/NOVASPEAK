// 头像展示相关纯函数：不发请求、不访问 DOM，方便 Node 原生测试。

/**
 * 取默认头像首字母：中文取第一个汉字，英文取大写首字母，空名称返回 "?"。
 */
export function getAvatarInitial(displayName) {
  if (typeof displayName !== "string") return "?";
  const trimmed = displayName.trim();
  if (!trimmed) return "?";
  const firstCharacter = Array.from(trimmed)[0];
  if (!firstCharacter) return "?";
  return firstCharacter.toLocaleUpperCase();
}

/**
 * 只接受站内相对路径（后端返回 /uploads/avatars/...），
 * 拒绝 javascript:、data:、协议相对 // 等危险地址；非法时返回 null。
 */
export function normalizeAvatarUrl(avatarUrl) {
  if (typeof avatarUrl !== "string") return null;
  const trimmed = avatarUrl.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  if (/[\s\\]/.test(trimmed)) return null;
  return trimmed;
}

export function shouldShowAvatarImage(avatarUrl) {
  return normalizeAvatarUrl(avatarUrl) !== null;
}

/**
 * 在 Presence 在线成员里按昵称找头像（Presence 公共数据不含用户 ID）。
 */
export function findAvatarUrlByDisplayName(members, displayName) {
  if (!Array.isArray(members)) return null;
  if (typeof displayName !== "string" || !displayName) return null;
  const match = members.find(
    (member) =>
      member &&
      (member.nickname === displayName || member.displayName === displayName)
  );
  return normalizeAvatarUrl(match?.avatarUrl);
}

/**
 * 频道成员卡片的头像来源：本人直接用 currentUser（上传后立即生效），
 * 其他成员用 Presence 在线成员数据。
 */
export function resolveParticipantAvatarUrl({
  isLocal = false,
  displayName = "",
  currentUser = null,
  onlineMembers = [],
} = {}) {
  if (isLocal === true) {
    return normalizeAvatarUrl(currentUser?.avatarUrl);
  }
  return findAvatarUrlByDisplayName(onlineMembers, displayName);
}

/**
 * 头像上传入口的 UI 模型：Admin/Member 可上传，Guest 不显示入口；
 * 删除入口只在已有头像时显示；上传中禁用全部操作。
 */
export function getAvatarUploadUiModel({
  role = "",
  avatarUrl = null,
  uploading = false,
} = {}) {
  const canUpload = role === "admin" || role === "member" || role === "user";
  const hasAvatar = normalizeAvatarUrl(avatarUrl) !== null;
  return {
    canUpload,
    showUploadEntry: canUpload,
    showDeleteEntry: canUpload && hasAvatar,
    actionsDisabled: uploading === true,
    hasAvatar,
  };
}
