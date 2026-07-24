import { getUserManagementCapabilities } from "./roles.js";

export function getParticipantMenuActions({ item, currentUser, currentChannel, channels = [] }) {
  const permissions = getUserManagementCapabilities(
    currentUser?.role,
    item?.role
  );
  const canManage =
    !item?.isLocal &&
    (permissions.canMove || permissions.canRemove || permissions.canServerMute);
  // 音乐机器人被移出后会中断整个频道的播放。保留本地音量/静音，
  // 但不向普通成员菜单提供服务器静音、移动或移出操作。
  if (!canManage || item?.isMusicBot === true) return [];
  const actions = [];
  if (permissions.canServerMute) actions.push(item?.serverMuted ? "unmute" : "mute");
  if (permissions.canMove) {
    actions.push("move");
    const currentChannelId = currentChannel?.id;
    actions.push(...channels.filter((channel) => channel?.id !== currentChannelId).map((channel) => `move:${channel.id}`));
  }
  if (permissions.canRemove) actions.push("remove");
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
