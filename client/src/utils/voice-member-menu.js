export function getParticipantMenuActions({ item, currentUser, currentChannel, channels = [] }) {
  const canManage = !item?.isLocal && ["admin", "member"].includes(currentUser?.role);
  if (!canManage) return [];
  const actions = [];
  if (currentUser?.role === "admin") actions.push(item?.serverMuted ? "unmute" : "mute");
  actions.push("move");
  const currentChannelId = currentChannel?.id;
  actions.push(...channels.filter((channel) => channel?.id !== currentChannelId).map((channel) => `move:${channel.id}`));
  actions.push("remove");
  return actions;
}

// 右键菜单模型：本地功能（查看资料 / 本地静音 / 音量）对所有人可见，
// 管理操作复用第一阶段的 getParticipantMenuActions，自己的卡片不显示本地静音和音量。
export function getMemberContextMenuModel({ item, currentUser, currentChannel, channels = [], localPref } = {}) {
  const isSelf = Boolean(item?.isLocal);
  return {
    showProfile: true,
    showLocalControls: !isSelf,
    localMuteAction: isSelf ? "" : (localPref?.muted === true ? "local-unmute" : "local-mute"),
    showVolumeSlider: !isSelf,
    managementActions: getParticipantMenuActions({ item, currentUser, currentChannel, channels }),
  };
}

// 卡片状态标签：服务器静音与本地静音可同时存在，互不覆盖。
export function getMemberStatusBadges({ serverMuted = false, localMuted = false } = {}) {
  const badges = [];
  if (serverMuted === true) badges.push({ type: "server-muted", label: "已被服务器静音" });
  if (localMuted === true) badges.push({ type: "local-muted", label: "已本地静音" });
  return badges;
}
