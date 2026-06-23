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
