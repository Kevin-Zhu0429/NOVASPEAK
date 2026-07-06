export function getParticipantMenuActions({ item, currentUser, currentChannel, channels = [] }) {
  const actions = getParticipantContextMenuItems({ item, currentUser, currentChannel, channels }).filter((entry) => entry.kind === "action");
  return actions.map((entry) => entry.action);
}

export function getParticipantContextMenuItems({ item, currentUser, currentChannel, channels = [] }) {
  if (!item) return [];
  const entries = [{ kind: "action", action: "profile", label: "查看成员资料" }];
  if (!item.isLocal) {
    entries.push({ kind: "action", action: item.localMuted ? "local-unmute" : "local-mute", label: item.localMuted ? "取消本地静音" : "本地静音" });
    entries.push({ kind: "volume", action: "local-volume", label: "音量" });
  }
  const canManage = !item.isLocal && ["admin", "member"].includes(currentUser?.role);
  if (!canManage) return entries;
  if (currentUser?.role === "admin") entries.push({ kind: "action", action: item.serverMuted ? "unmute" : "mute", label: item.serverMuted ? "解除服务器静音" : "服务器静音" });
  entries.push({ kind: "action", action: "move", label: "移动到其他频道" });
  const currentChannelId = currentChannel?.id;
  entries.push(...channels.filter((channel) => channel?.id !== currentChannelId).map((channel) => ({ kind: "action", action: `move:${channel.id}`, label: channel.name })));
  entries.push({ kind: "action", action: "remove", label: "移出当前频道" });
  return entries;
}

export function getRoleLabel(role) {
  if (role === "admin") return "管理员";
  if (role === "member") return "战队成员";
  if (role === "guest") return "访客";
  return "身份未知";
}

export function getParticipantStatusLabels(item) {
  return {
    serverMuted: item?.serverMuted ? "已被服务器静音" : "未被服务器静音",
    localMuted: item?.localMuted ? "已本地静音" : "未本地静音",
  };
}
